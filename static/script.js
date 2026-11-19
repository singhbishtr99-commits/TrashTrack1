// UI only. Classification and the assistant run in Python (app.py).

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const MAPS_KEY = document.body.dataset.mapsKey || "";

let view = "home";
let mode = "camera";
let stream = null;
let lastResult = null;

/* =========================================================
   ROUTER
   ========================================================= */
function go(name, opts = {}) {
  view = name;
  $$(".view").forEach((v) => (v.hidden = v.id !== "view-" + name));
  $$(".tabs [data-nav]").forEach((b) => b.classList.toggle("active", b.dataset.nav === name));
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (name === "analyze") {
    resetAnalyze();
    setMode(opts.mode || mode);
  } else {
    stopCamera();
  }
  if (name === "map") initMap(opts.category);
}

$$("[data-nav]").forEach((b) => (b.onclick = () => go(b.dataset.nav)));
$$("[data-go]").forEach((b) => (b.onclick = () => go("analyze", { mode: b.dataset.go })));

/* =========================================================
   SCAN / UPLOAD
   ========================================================= */
function setMode(m) {
  mode = m;
  $$("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  $("#panel-camera").hidden = m !== "camera";
  $("#panel-upload").hidden = m !== "upload";
  if (m === "camera" && view === "analyze") startCamera(); else stopCamera();
}
$$("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

function resetAnalyze() {
  $("#inputArea").hidden = false;
  $("#resultArea").hidden = true;
  $("#fileInput").value = "";
}

async function startCamera() {
  if (stream) return;
  $("#cameraError").hidden = true;
  $("#cameraBox").hidden = false;
  $("#captureBtn").hidden = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    if (view !== "analyze" || mode !== "camera") return stopCamera(); // user left meanwhile
    $("#video").srcObject = stream;
  } catch (err) {
    $("#cameraBox").hidden = true;
    $("#captureBtn").hidden = true;
    $("#cameraError").textContent =
      "Camera unavailable (" + err.message + "). Allow camera access (works on https:// or localhost), or use Upload instead.";
    $("#cameraError").hidden = false;
  }
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $("#video").srcObject = null;
}

$("#captureBtn").onclick = () => {
  const v = $("#video");
  if (!v.videoWidth) return;
  const c = $("#canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  const img = new Image();
  img.onload = () => analyze(img);
  img.src = c.toDataURL("image/jpeg", 0.9);
};

function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const img = new Image();
  img.onload = () => analyze(img);
  img.src = URL.createObjectURL(file);
}
$("#fileInput").onchange = (e) => loadFile(e.target.files[0]);

const dz = $("#dropzone");
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
dz.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));

function shrink(img, max = 900) {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}

async function analyze(img) {
  stopCamera();
  const dataUrl = shrink(img);
  $("#inputArea").hidden = true;
  $("#resultArea").hidden = false;
  $("#preview").src = dataUrl;
  $("#loading").hidden = false;
  $("#errorMsg").hidden = true;
  $("#result").hidden = true;
  $("#successActions").hidden = true;

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    renderResult(data);
  } catch (err) {
    $("#errorMsg").textContent = err.message;
    $("#errorMsg").hidden = false;
  } finally {
    $("#loading").hidden = true;
  }
}

function renderResult(d) {
  lastResult = d;
  const box = $("#result");
  box.className = "result " + d.card_class;
  $("#resIcon").textContent = d.icon;
  $("#resItem").textContent = d.item;
  $("#resBin").textContent = d.bin_name;
  $("#resConf").textContent = d.confidence;
  $("#resTip").textContent = d.explanation;
  $("#safetyWarn").hidden = !d.uncertain;
  $("#meterFill").style.width = "0";
  box.hidden = false;
  $("#successActions").hidden = false;
  requestAnimationFrame(() => ($("#meterFill").style.width = d.confidence + "%"));
}

$("#scanAgain").onclick = () => go("analyze");
$("#askAbout").onclick = () => {
  go("chat");
  if (lastResult) sendChat(`How should I dispose of ${lastResult.item} properly? Any tips to reduce or reuse it?`);
};
$("#findDropoff").onclick = () => {
  const map = { Recyclable: "recycling", Organic: "compost", Hazardous: "ewaste" };
  const cat = lastResult && !lastResult.uncertain ? map[lastResult.category] || "pickup" : "pickup";
  go("map", { category: cat });
};

/* =========================================================
   MAP (Google Maps JavaScript API + Places API New)
   ========================================================= */
const QUERIES = {
  pickup: "waste collection service garbage pickup",
  recycling: "recycling center",
  ewaste: "e-waste recycling drop-off",
  scrap: "scrap dealer",
  compost: "composting facility",
};
const DEFAULT_CENTER = { lat: 20.5937, lng: 78.9629 };

let activeCat = "pickup";
let userPos = null;
let locAsked = false;
let gmaps = null; // loaded libraries
let map = null;
let infoWin = null;
let markers = [];
let userMarker = null;

function loadMaps() {
  if (gmaps) return Promise.resolve(gmaps);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}&loading=async&v=weekly`;
    s.async = true;
    s.onerror = () => reject(new Error("Could not load Google Maps. Check your internet and API key."));
    s.onload = async () => {
      try {
        const [m, p, mk] = await Promise.all([
          google.maps.importLibrary("maps"),
          google.maps.importLibrary("places"),
          google.maps.importLibrary("marker"),
        ]);
        gmaps = { Map: m.Map, InfoWindow: m.InfoWindow, Place: p.Place, Marker: mk.AdvancedMarkerElement, Pin: mk.PinElement };
        resolve(gmaps);
      } catch (e) {
        reject(e);
      }
    };
    document.head.appendChild(s);
  });
}

function mapStatus(msg, type = "") {
  const el = $("#mapStatus");
  el.textContent = msg || "";
  el.className = "notice " + type;
  el.hidden = !msg;
}

function setChip(cat) {
  activeCat = cat;
  $$("#chips .chip").forEach((c) => c.classList.toggle("active", c.dataset.cat === cat));
}

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 8000 }
    );
  });
}

async function initMap(cat) {
  if (cat) setChip(cat);
  if (!MAPS_KEY) {
    mapStatus("Add GOOGLE_MAPS_API_KEY to your .env file and restart the server to enable the map.", "warn");
    return;
  }
  if (!userPos && !locAsked) {
    locAsked = true;
    mapStatus("Getting your location…");
    userPos = await getLocation();
  }
  searchPlaces();
}

const km = (a, b) => {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

async function searchPlaces() {
  const area = $("#areaInput").value.trim();
  mapStatus("Searching…");
  let g;
  try {
    g = await loadMaps();
  } catch (e) {
    return mapStatus(e.message, "error");
  }

  if (!map) {
    map = new g.Map($("#map"), {
      center: userPos || DEFAULT_CENTER,
      zoom: userPos ? 13 : 5,
      mapId: "DEMO_MAP_ID",
      mapTypeControl: false,
      streetViewControl: false,
    });
    infoWin = new g.InfoWindow();
  }

  const request = {
    textQuery: area ? `${QUERIES[activeCat]} in ${area}` : QUERIES[activeCat],
    fields: ["displayName", "formattedAddress", "location", "rating", "userRatingCount", "googleMapsURI"],
    maxResultCount: 20,
  };
  if (!area && userPos) request.locationBias = { center: userPos, radius: 10000 };

  if (!area && !userPos) {
    mapStatus("Location is blocked, so results may be far away. Type a city or area above to search there.", "warn");
  }

  let places;
  try {
    ({ places } = await g.Place.searchByText(request));
  } catch (e) {
    return mapStatus("Search failed: " + e.message + ". Make sure “Maps JavaScript API” and “Places API (New)” are enabled.", "error");
  }

  clearMarkers();
  $("#placeList").replaceChildren();

  if (!places || !places.length) {
    mapStatus("");
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No places found. Try another category or a different area.";
    $("#placeList").appendChild(p);
    return;
  }
  if (area || userPos) mapStatus("");

  const ref = area ? null : userPos;
  const items = places.map((p) => {
    const pos = { lat: p.location.lat(), lng: p.location.lng() };
    return { p, pos, dist: ref ? km(ref, pos) : null };
  });
  if (ref) items.sort((a, b) => a.dist - b.dist);

  const bounds = new google.maps.LatLngBounds();
  if (userPos && !area) {
    const dot = document.createElement("div");
    dot.className = "pin-user";
    userMarker = new g.Marker({ map, position: userPos, content: dot, title: "You are here" });
    bounds.extend(userPos);
  }

  items.forEach(({ p, pos, dist }) => {
    const marker = new g.Marker({ map, position: pos, title: p.displayName });
    markers.push(marker);
    bounds.extend(pos);

    const card = buildCard(p, pos, dist);
    $("#placeList").appendChild(card);

    const open = () => {
      $$(".place").forEach((x) => x.classList.remove("on"));
      card.classList.add("on");
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      infoWin.setContent(buildInfo(p, pos));
      infoWin.open({ map, anchor: marker });
    };
    marker.addListener("click", open);
    card.onclick = (e) => {
      if (e.target.tagName === "A") return;
      map.panTo(pos);
      map.setZoom(16);
      open();
    };
  });

  map.fitBounds(bounds, 60);
}

function clearMarkers() {
  markers.forEach((m) => (m.map = null));
  markers = [];
  if (userMarker) userMarker.map = null;
  userMarker = null;
  if (infoWin) infoWin.close();
}

const dirUrl = (pos) => `https://www.google.com/maps/dir/?api=1&destination=${pos.lat},${pos.lng}`;

function buildCard(p, pos, dist) {
  const el = document.createElement("div");
  el.className = "place";
  el.tabIndex = 0;

  const name = document.createElement("b");
  name.textContent = p.displayName || "Unnamed place";
  const addr = document.createElement("div");
  addr.className = "addr";
  addr.textContent = p.formattedAddress || "";

  const meta = document.createElement("div");
  meta.className = "meta";
  const info = document.createElement("span");
  const bits = [];
  if (dist != null) bits.push(dist < 1 ? Math.round(dist * 1000) + " m" : dist.toFixed(1) + " km");
  if (p.rating) bits.push("⭐ " + p.rating + (p.userRatingCount ? ` (${p.userRatingCount})` : ""));
  info.textContent = bits.join(" · ");
  const link = document.createElement("a");
  link.href = dirUrl(pos);
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Directions ↗";
  meta.append(info, link);

  el.append(name, addr, meta);
  return el;
}

function buildInfo(p, pos) {
  const box = document.createElement("div");
  box.className = "iw";
  const b = document.createElement("b");
  b.textContent = p.displayName || "Place";
  const a = document.createElement("div");
  a.textContent = p.formattedAddress || "";
  const l = document.createElement("a");
  l.href = dirUrl(pos);
  l.target = "_blank";
  l.rel = "noopener";
  l.textContent = "Get directions";
  box.append(b, a, l);
  return box;
}

$$("#chips .chip").forEach((c) => (c.onclick = () => { setChip(c.dataset.cat); initMap(); }));
$("#areaForm").onsubmit = (e) => { e.preventDefault(); initMap(); };
$("#useLocation").onclick = async () => {
  $("#areaInput").value = "";
  mapStatus("Getting your location…");
  userPos = await getLocation();
  locAsked = true;
  initMap();
};

/* =========================================================
   ASSISTANT (chat, answered by Gemini through Python)
   ========================================================= */
const history = [];
let busy = false;

function renderMd(text) {
  // Escape first, then add a little formatting, so model output can never inject HTML.
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  let html = "", inList = false;
  for (const line of esc(text).split("\n")) {
    const m = line.match(/^\s*[*-]\s+(.*)/);
    if (m) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(m[1])}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

function addMsg(role, text, isError = false) {
  const el = document.createElement("div");
  el.className = "msg " + role + (isError ? " error" : "");
  if (role === "bot") el.innerHTML = renderMd(text);
  else el.textContent = text;
  $("#messages").appendChild(el);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  return el;
}

function addTyping() {
  const el = document.createElement("div");
  el.className = "msg bot typing";
  el.innerHTML = "<span></span><span></span><span></span>";
  $("#messages").appendChild(el);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  return el;
}

async function sendChat(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  $("#suggest").hidden = true;
  addMsg("user", text);
  const typing = addTyping();

  const payload = {
    message: text,
    history: history.slice(-12),
    context: lastResult ? { item: lastResult.item, category: lastResult.category, explanation: lastResult.explanation } : null,
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    history.push({ role: "user", text }, { role: "model", text: data.reply });
    addMsg("bot", data.reply);
  } catch (err) {
    addMsg("bot", err.message, true);
  } finally {
    typing.remove();
    busy = false;
  }
}

$("#chatForm").onsubmit = (e) => {
  e.preventDefault();
  const v = $("#chatInput").value;
  $("#chatInput").value = "";
  sendChat(v);
};
$$("#suggest button").forEach((b) => (b.onclick = () => sendChat(b.textContent)));

addMsg("bot", "Hi! I'm your **waste assistant**. Ask me how to sort, recycle, compost or safely dispose of anything.");

/* ---------- INIT ---------- */
go("home");