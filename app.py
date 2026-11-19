"""EcoSort AI - Flask backend.

Python does all the logic: image classification, the waste assistant (chat),
Google Places lookups, safety rule and config. HTML/CSS/JS only display things.
"""
import base64
import io
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from flask import Flask, jsonify, render_template, request
from PIL import Image

try:  # loads values from a .env file next to app.py
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 12 * 1024 * 1024  # 12 MB upload cap

# ---------------- CONFIG ----------------
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
# Google Maps Platform. Server key: enable "Places API (New)" and "Geocoding API".
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "")
# Browser key for the Maps JavaScript API (falls back to the server key if not set).
GOOGLE_MAPS_JS_KEY = os.getenv("GOOGLE_MAPS_JS_KEY", "") or GOOGLE_MAPS_API_KEY
PLACES_URL = "https://places.googleapis.com/v1/places:searchText"
GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
PLACES_FIELDS = ",".join([
    "places.id", "places.displayName", "places.formattedAddress", "places.location",
    "places.googleMapsUri", "places.websiteUri", "places.rating",
    "places.currentOpeningHours.openNow",
])
SEARCH_RADIUS_M = 50000  # Google's maximum bias radius
MAX_DISTANCE_KM = 60     # drop results that are much farther than the search area
MAX_PLACES = 30
CACHE_SECONDS = 600
CONFIDENCE_THRESHOLD = 65  # below this => uncertain (safety-first rule)

BINS = {
    "Recyclable": ("recyclable", "🔵", "Blue Bin (Dry Recyclables)"),
    "Organic": ("organic", "🟢", "Green Bin (Wet / Organic Waste)"),
    "Hazardous": ("hazardous", "🔴", "Red Bin (Hazardous / E-Waste)"),
    "General Waste": ("general", "🗑️", "Black Bin (General Waste)"),
}

SCAN_PROMPT = """
Analyze this waste item and classify it into one of these exact categories:
['Recyclable', 'Organic', 'Hazardous', 'General Waste'].

If the image is blurry, ambiguous, or hard to classify safely, set 'uncertain' to true and lower the confidence.

Return ONLY a valid JSON object without markdown code blocks:
{
  "item": "name of item",
  "category": "category name",
  "confidence": integer 0 to 100,
  "explanation": "educational disposal tip (1-2 sentences)",
  "uncertain": boolean (true or false)
}
"""

# Google Places text searches for each map category (results from all queries are merged)
PLACE_QUERIES = {
    "pickup": {
        "label": "Waste collection point",
        "queries": ["waste collection point", "garbage collection centre", "waste transfer station", "municipal waste disposal"],
    },
    "recycling": {
        "label": "Recycling point",
        "queries": ["recycling center", "recycling drop off"],
    },
    "ewaste": {
        "label": "E-waste / battery drop-off",
        "queries": ["e-waste recycling", "electronic waste drop off", "battery recycling"],
    },
    "scrap": {
        "label": "Scrap dealer",
        "queries": ["scrap dealer", "scrap metal yard"],
    },
    "compost": {
        "label": "Compost / green-waste drop-off",
        "queries": ["composting facility", "green waste disposal"],
    },
}

ASSISTANT_SYSTEM = """You are EcoSort Assistant, a friendly expert on waste management inside the EcoSort AI app.
You help with: how to sort and dispose of items, recycling, composting, e-waste, hazardous waste,
reducing waste, reuse ideas, and what the app's bin colours mean
(Blue = dry recyclables, Green = wet/organic, Red = hazardous/e-waste, Black = general waste).

Rules:
- Stay on waste, recycling, composting, sustainability and related topics. Politely decline anything else
  and steer back to waste.
- Be concise: short paragraphs or a few bullet points. Use **bold** for key words.
- Local rules differ by city and country. If it matters, say so and suggest checking local guidelines;
  never invent specific laws, schedules or phone numbers.
- For hazardous items (batteries, chemicals, medical waste, sharp objects), put safety first.
- To find collection points, tell the user to open the "Nearby" tab of the app.
"""


# ---------------- LOGIC ----------------
def build_result(data: dict) -> dict:
    """Turn raw classification data into everything the UI needs."""
    try:
        confidence = int(float(data.get("confidence", 0)))
    except (TypeError, ValueError):
        confidence = 0
    confidence = max(0, min(100, confidence))

    category = data.get("category", "General Waste")
    uncertain = bool(data.get("uncertain", False)) or confidence < CONFIDENCE_THRESHOLD

    if uncertain:
        card_class, icon, bin_name = "uncertain", "⚠️", "Requires Manual Inspection"
    else:
        card_class, icon, bin_name = BINS.get(category, BINS["General Waste"])

    return {
        "item": str(data.get("item") or "Unknown Item"),
        "category": category if category in BINS else "General Waste",
        "confidence": confidence,
        "explanation": str(data.get("explanation") or ""),
        "uncertain": uncertain,
        "card_class": card_class,
        "icon": icon,
        "bin_name": bin_name,
    }


def parse_model_json(text: str) -> dict:
    """Strip ```json fences and pull out the JSON object from the model reply."""
    clean = text.replace("```json", "").replace("```", "").strip()
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", clean, re.DOTALL)
        if match:
            return json.loads(match.group(0))
        raise


def ask_gemini(contents, system=None, json_mode=False) -> str:
    """Single place where Gemini is called."""
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not set on the server")

    from google import genai  # imported here so the app starts even before install
    from google.genai import types

    client = genai.Client(api_key=GEMINI_API_KEY)
    config = types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json" if json_mode else None,
    )
    response = client.models.generate_content(
        model=GEMINI_MODEL, contents=contents, config=config
    )
    return response.text or ""


def decode_image(data_url: str) -> Image.Image:
    """Decode a base64 data URL into a PIL image, shrunk to max 768px."""
    b64 = data_url.split(",", 1)[1] if "," in data_url else data_url
    image = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
    image.thumbnail((768, 768))
    return image


def clean_history(history) -> list:
    """Keep only valid, short, recent chat turns."""
    out = []
    if not isinstance(history, list):
        return out
    for turn in history[-12:]:
        if not isinstance(turn, dict):
            continue
        role = "model" if turn.get("role") == "model" else "user"
        text = str(turn.get("text", ""))[:2000].strip()
        if text:
            out.append({"role": role, "parts": [{"text": text}]})
    return out


def context_note(ctx) -> str:
    """Tell the assistant about the item the user just scanned."""
    if not isinstance(ctx, dict) or not ctx.get("item"):
        return ""
    return (
        "\n\nThe user just scanned this item in the app: "
        f"{str(ctx.get('item'))[:100]} (category: {str(ctx.get('category', ''))[:30]}). "
        f"App tip: {str(ctx.get('explanation', ''))[:300]}"
    )


_cache = {}  # tiny in-memory cache so we are kind to the free map services


def cached(key, ttl, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    value = fn()
    _cache[key] = (time.time(), value)
    return value


def http_json(url, payload=None, headers=None):
    """GET (no payload) or POST JSON, returning parsed JSON. Raises RuntimeError with Google's message."""
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        try:
            detail = json.load(e).get("error", {}).get("message", "")
        except Exception:
            detail = ""
        raise RuntimeError(detail or f"HTTP {e.code}")


def geocode(area: str):
    """Turn a place name ("Pune") into coordinates using the Google Geocoding API."""
    def fetch():
        qs = urllib.parse.urlencode({"address": area, "key": GOOGLE_MAPS_API_KEY})
        data = http_json(f"{GEOCODE_URL}?{qs}")
        status = data.get("status")
        if status == "ZERO_RESULTS":
            return None
        if status != "OK":
            raise RuntimeError(data.get("error_message") or status)
        loc = data["results"][0]["geometry"]["location"]
        return {"lat": loc["lat"], "lng": loc["lng"]}
    return cached(("geo", area.lower()), 24 * 3600, fetch)


def distance_km(lat1, lng1, lat2, lng2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def search_text(query: str, lat: float, lng: float) -> list:
    """One Google Places (New) text search, biased towards a point."""
    body = {
        "textQuery": query,
        "maxResultCount": 20,
        "locationBias": {"circle": {"center": {"latitude": lat, "longitude": lng}, "radius": SEARCH_RADIUS_M}},
    }
    headers = {"X-Goog-Api-Key": GOOGLE_MAPS_API_KEY, "X-Goog-FieldMask": PLACES_FIELDS}
    return http_json(PLACES_URL, body, headers).get("places", [])


def parse_place(p: dict, default_name: str, lat: float, lng: float):
    loc = p.get("location") or {}
    plat, plng = loc.get("latitude"), loc.get("longitude")
    if plat is None or plng is None:
        return None
    return {
        "id": p.get("id", ""),
        "name": (p.get("displayName") or {}).get("text") or default_name,
        "address": p.get("formattedAddress", ""),
        "lat": plat,
        "lng": plng,
        "distance_km": round(distance_km(lat, lng, plat, plng), 2),
        "open_now": (p.get("currentOpeningHours") or {}).get("openNow"),
        "rating": p.get("rating"),
        "website": p.get("websiteUri", ""),
    }


def find_places(cat: str, lat: float, lng: float):
    """Run every query for the category, merge + de-duplicate, sort by distance."""
    def fetch():
        if not GOOGLE_MAPS_API_KEY:
            raise RuntimeError("GOOGLE_MAPS_API_KEY is not set on the server")
        default_name = PLACE_QUERIES[cat]["label"]
        seen, out = set(), []
        for query in PLACE_QUERIES[cat]["queries"]:
            for p in search_text(query, lat, lng):
                place = parse_place(p, default_name, lat, lng)
                key = place and (place["id"] or (place["lat"], place["lng"]))
                if not place or key in seen or place["distance_km"] > MAX_DISTANCE_KM:
                    continue
                seen.add(key)
                out.append(place)
        out.sort(key=lambda x: x["distance_km"])
        out = out[:MAX_PLACES]
        radius_km = max(1, math.ceil(out[-1]["distance_km"])) if out else MAX_DISTANCE_KM
        return out, radius_km
    return cached(("places", cat, round(lat, 3), round(lng, 3)), CACHE_SECONDS, fetch)


# ---------------- ROUTES ----------------
@app.route("/")
def index():
    return render_template("index.html", maps_key=GOOGLE_MAPS_JS_KEY)


@app.route("/api/places")
def places():
    cat = request.args.get("cat", "pickup")
    if cat not in PLACE_QUERIES:
        return jsonify({"error": "Unknown category."}), 400

    area = request.args.get("area", "").strip()[:100]
    try:
        if area:
            center = geocode(area)
            if not center:
                return jsonify({"error": f"Couldn't find “{area}”. Try a city or town name."}), 404
        else:
            try:
                center = {"lat": float(request.args["lat"]), "lng": float(request.args["lng"])}
            except (KeyError, ValueError):
                return jsonify({"error": "Missing or invalid location."}), 400
            if not (-90 <= center["lat"] <= 90 and -180 <= center["lng"] <= 180):
                return jsonify({"error": "Location out of range."}), 400
        found, radius_km = find_places(cat, center["lat"], center["lng"])
    except Exception as e:
        return jsonify({"error": f"Map search failed: {e}"}), 502

    return jsonify({"center": center, "radius_km": radius_km, "places": found})


@app.route("/api/analyze", methods=["POST"])
def analyze():
    payload = request.get_json(silent=True) or {}
    image_data = payload.get("image")
    if not image_data:
        return jsonify({"error": "No image received."}), 400

    try:
        image = decode_image(image_data)
    except Exception:
        return jsonify({"error": "Could not read that image."}), 400

    try:
        text = ask_gemini([SCAN_PROMPT, image], json_mode=True)
        data = parse_model_json(text)
    except Exception as e:
        return jsonify({
            "error": f"Analysis error: {e}. Make sure your Gemini API key is configured correctly."
        }), 502

    return jsonify(build_result(data))


@app.route("/api/chat", methods=["POST"])
def chat():
    payload = request.get_json(silent=True) or {}
    message = str(payload.get("message", "")).strip()[:1000]
    if not message:
        return jsonify({"error": "Please type a question."}), 400

    contents = clean_history(payload.get("history"))
    contents.append({"role": "user", "parts": [{"text": message}]})
    system = ASSISTANT_SYSTEM + context_note(payload.get("context"))

    try:
        reply = ask_gemini(contents, system=system)
    except Exception as e:
        return jsonify({"error": f"Assistant error: {e}"}), 502

    return jsonify({"reply": reply.strip() or "Sorry, I couldn't come up with an answer. Try rephrasing?"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)