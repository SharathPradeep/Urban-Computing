import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  addDoc,
  getDoc,
  getDocs,
  query,
  orderBy,
  updateDoc,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

// ---------------------------------------------------------------------------
// FIREBASE INIT
// ---------------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyAhw_Q8LwkTA_MhsCX-SsKST5zSA2wdwSo",
  authDomain: "walkguide-68d15.firebaseapp.com",
  projectId: "walkguide-68d15",
  storageBucket: "walkguide-68d15.firebasestorage.app",
  messagingSenderId: "873504166739",
  appId: "1:873504166739:web:6fbfe0970dad0dff45c7a6",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence);
const db = getFirestore(app);

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

// ---------------------------------------------------------------------------
// DOM REFERENCES
// ---------------------------------------------------------------------------
const homeView = document.getElementById("homeView");
const analyticsView = document.getElementById("analyticsView");
const historyView = document.getElementById("historyView");

const authButton = document.getElementById("authButton");
const recordButton = document.getElementById("recordButton");
const recordStatus = document.getElementById("recordStatus");
const quickAnalyticsButton = document.getElementById("quickAnalyticsButton");

const recommendRow = document.getElementById("recommendRow");
const recommendationSection = document.getElementById("recommendationSection");
const recommendCard = document.getElementById("recommendCard");
const todayRecButton = document.getElementById("todayRecButton");
const tomorrowRecButton = document.getElementById("tomorrowRecButton");

const pastWalksSection = document.getElementById("pastWalksSection");
const walksTableBody = document.getElementById("walksTableBody");
const historyAnalyticsButton = document.getElementById("historyAnalyticsButton");

const backFromAnalytics = document.getElementById("backFromAnalytics");
const backFromHistory = document.getElementById("backFromHistory");

const analyticsTitle = document.getElementById("analyticsTitle");
const analyticsSubtitle = document.getElementById("analyticsSubtitle");
const locNameEl = document.getElementById("locName");
const walkDurationEl = document.getElementById("walkDuration");
const walkStartedAtEl = document.getElementById("walkStartedAt");
const walkScoreTextEl = document.getElementById("walkScoreText");
const avgTempEl = document.getElementById("avgTemp");
const avgHumidityEl = document.getElementById("avgHumidity");
const avgWindEl = document.getElementById("avgWind");
const avgPrecipEl = document.getElementById("avgPrecip");
const weatherScoreTextEl = document.getElementById("weatherScoreText");
const avgPm25El = document.getElementById("avgPm25");
const avgPm10El = document.getElementById("avgPm10");
const avgAqiEl = document.getElementById("avgAqi");
const airScoreTextEl = document.getElementById("airScoreText");

const historySummaryText = document.getElementById("historySummaryText");

const micCanvas = document.getElementById("micChart");
const historyScoreCanvas = document.getElementById("historyScoreChart");
const historyAvgCanvas = document.getElementById("historyAvgChart");

// ---------------------------------------------------------------------------
// GLOBAL STATE
// ---------------------------------------------------------------------------
let currentUser = null;
let isRecording = false;

let currentSessionRef = null;
let currentAgg = null;
let totalReadings = 0;
let lastCompletedSessionId = null;
let userSessionsCache = [];

let lastPos = null;
let geoWatchId = null;

let audioContext = null;
let micSource = null;
let analyser = null;
let micBuf = null;
let micRafId = null;
let sumDB = 0;
let countDB = 0;

let flushTimerId = null;
let weatherTimerId = null;
let airTimerId = null;

const wxCache = {
  weather: null,
  air: null,
};

let micChart = null;
let historyScoreChart = null;
let historyAvgChart = null;

let currentRecMode = null; // "today" | "tomorrow" | null

// ---------------------------------------------------------------------------
// VIEW HELPERS
// ---------------------------------------------------------------------------
function showView(viewId) {
  for (const v of [homeView, analyticsView, historyView]) {
    v.classList.remove("active");
  }
  if (viewId === "home") homeView.classList.add("active");
  if (viewId === "analytics") analyticsView.classList.add("active");
  if (viewId === "history") historyView.classList.add("active");
}

// ---------------------------------------------------------------------------
// GENERIC HELPERS
// ---------------------------------------------------------------------------
function fmt(num, digits = 1) {
  if (num === null || num === undefined || Number.isNaN(num)) return "--";
  return Number(num).toFixed(digits);
}

// Convert various Firestore timestamp formats -> JS Date or null
function toJsDateMaybe(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value.seconds === "number")
    return new Date(value.seconds * 1000);
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function clean(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    if (typeof v === "object" && !(v instanceof Timestamp)) out[k] = clean(v);
    else out[k] = v;
  }
  return out;
}


function formatTimeShort(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Reverse geocode for nice location name
async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
  try {
    const res = await fetch(url, {
      headers: { "Accept-Language": "en" },
    });
    if (!res.ok) throw new Error("Reverse geocode failed");
    const data = await res.json();
    const addr = data.address || {};
    const { city, town, village, suburb, state, country } = addr;
    const place = city || town || village || suburb || state || "Unknown place";
    return `${place}, ${country || ""}`.trim();
  } catch (err) {
    console.warn("Reverse geocode error", err);
    return "Unknown place";
  }
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------
function updateAuthUI(user) {
  if (!user) {
    authButton.textContent = "Login / Signup";
    authButton.title = "Not signed in";
    recordButton.disabled = true;
    recordStatus.textContent = "Please login to start.";

    if (recommendRow) recommendRow.classList.add("hidden");
    if (recommendationSection) recommendationSection.classList.add("hidden");
    if (recommendCard) recommendCard.innerHTML = "";
    currentRecMode = null;

    if (pastWalksSection) pastWalksSection.classList.add("hidden");
    if (historyAnalyticsButton)
      historyAnalyticsButton.classList.add("hidden");

    walksTableBody.innerHTML = "";
    quickAnalyticsButton.hidden = true;
  } else {
    authButton.textContent = "Logout";
    authButton.title = `Signed in as ${user.email || ""}`;
    recordButton.disabled = false;
    recordStatus.textContent = "Ready to record your next walk.";

    if (recommendRow) recommendRow.classList.remove("hidden");
    // keep recommendationSection hidden until user clicks a button
    if (pastWalksSection) pastWalksSection.classList.remove("hidden");
    if (historyAnalyticsButton)
      historyAnalyticsButton.classList.remove("hidden");
  }
}

authButton.addEventListener("click", async () => {
  if (!currentUser) {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error(err);
      alert("Google sign-in failed. Please try again.");
    }
  } else {
    try {
      await signOut(auth);
    } catch (err) {
      console.error(err);
      alert("Sign-out failed. Please try again.");
    }
  }
});

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  updateAuthUI(user);

  userSessionsCache = [];
  walksTableBody.innerHTML = "";
  lastCompletedSessionId = null;
  quickAnalyticsButton.hidden = true;

  if (user) {
    await loadPastWalksForUser(user.uid);
  }
});

// ---------------------------------------------------------------------------
// GEOLOCATION
// ---------------------------------------------------------------------------
function getCurrentPositionOnce() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation not supported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        lastPos = { lat: latitude, lon: longitude, acc: accuracy };
        resolve(lastPos);
      },
      (err) => reject(err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  });
}

function startGpsWatch() {
  if (!navigator.geolocation) return;
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      lastPos = { lat: latitude, lon: longitude, acc: accuracy };
    },
    (err) => console.warn("GPS watch error", err),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );
}

function stopGpsWatch() {
  if (geoWatchId != null) navigator.geolocation.clearWatch(geoWatchId);
  geoWatchId = null;
}

// ---------------------------------------------------------------------------
// MICROPHONE
// ---------------------------------------------------------------------------
const MIC_WARMUP_MS = 1200;
const MIN_DBFS = -100;
const MAX_DBFS = 0;

function dbfs(rms) {
  const v = Math.max(rms, 1e-12);
  let d = 20 * Math.log10(v);
  if (!Number.isFinite(d)) d = MIN_DBFS;
  return Math.max(MIN_DBFS, Math.min(MAX_DBFS, d));
}

async function startMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Microphone not supported");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  micSource = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  micBuf = new Float32Array(analyser.fftSize);
  micSource.connect(analyser);

  sumDB = 0;
  countDB = 0;
  const startTime = performance.now();

  function sampleMic() {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(micBuf);
    let s = 0;
    for (let i = 0; i < micBuf.length; i++) s += micBuf[i] * micBuf[i];
    const rms = Math.sqrt(s / micBuf.length);
    const vdb = dbfs(rms);

    const now = performance.now();
    if (now - startTime > MIC_WARMUP_MS) {
      if (vdb >= MIN_DBFS && vdb <= MAX_DBFS) {
        sumDB += vdb;
        countDB += 1;
      }
    }

    micRafId = requestAnimationFrame(sampleMic);
  }

  micRafId = requestAnimationFrame(sampleMic);
}

function stopMic() {
  if (micRafId != null) cancelAnimationFrame(micRafId);
  micRafId = null;
  if (micSource) {
    try {
      micSource.disconnect();
    } catch {}
  }
  if (audioContext) {
    try {
      audioContext.close();
    } catch {}
  }
  analyser = null;
  audioContext = null;
  micSource = null;
  micBuf = null;
}

// ---------------------------------------------------------------------------
// WEATHER + AIR (Open-Meteo current endpoints)
// ---------------------------------------------------------------------------
async function fetchWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,cloud_cover&timezone=auto";
  const res = await fetch(url);
  if (!res.ok) {
    console.error("Weather fetch failed", res.status);
    return;
  }
  const json = await res.json();
  wxCache.weather = json.current ?? null;
}

async function fetchAir(lat, lon) {
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    "&current=pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,european_aqi&timezone=auto";
  const res = await fetch(url);
  if (!res.ok) {
    console.error("Air fetch failed", res.status);
    return;
  }
  const json = await res.json();
  wxCache.air = json.current ?? null;
}

// ---------------------------------------------------------------------------
// AGGREGATOR & SCORING
// ---------------------------------------------------------------------------
function resetAggregator() {
  currentAgg = {
    startTs: null,
    endTs: null,
    count: 0,
    noiseSum: 0,
    tempSum: 0,
    humiditySum: 0,
    windSum: 0,
    precipSum: 0,
    pm25Sum: 0,
    pm10Sum: 0,
    aqiSum: 0,
  };
}

function scoreNoise(avgDbfs) {
  const QUIET = -80;
  const LOUD = -25;
  if (!Number.isFinite(avgDbfs)) return 50;
  const clamped = Math.min(LOUD, Math.max(QUIET, avgDbfs));
  const t = (clamped - LOUD) / (QUIET - LOUD); // 0 loud, 1 quiet
  return Math.round(t * 100);
}

function scoreWeather(tempC, humidityPct, windMs, precipMm) {
  let tempScore;
  if (!Number.isFinite(tempC)) tempScore = 50;
  else if (tempC <= 0 || tempC >= 35) tempScore = 0;
  else if (tempC >= 15 && tempC <= 22) tempScore = 100;
  else if (tempC < 15) tempScore = ((tempC - 0) / (15 - 0)) * 100;
  else tempScore = ((35 - tempC) / (35 - 22)) * 100;

  let humScore;
  if (!Number.isFinite(humidityPct)) humScore = 50;
  else if (humidityPct <= 20 || humidityPct >= 90) humScore = 0;
  else if (humidityPct >= 40 && humidityPct <= 60) humScore = 100;
  else if (humidityPct < 40)
    humScore = ((humidityPct - 20) / (40 - 20)) * 100;
  else humScore = ((90 - humidityPct) / (90 - 60)) * 100;

  let windScore;
  if (!Number.isFinite(windMs)) windScore = 50;
  else if (windMs >= 12) windScore = 0;
  else if (windMs >= 1 && windMs <= 5) windScore = 100;
  else if (windMs < 1) windScore = windMs * 100;
  else windScore = ((12 - windMs) / (12 - 5)) * 100;

  let rainScore;
  if (!Number.isFinite(precipMm)) rainScore = 50;
  else if (precipMm === 0) rainScore = 100;
  else if (precipMm >= 4) rainScore = 0;
  else rainScore = ((4 - precipMm) / 4) * 100;

  return Math.round(
    0.5 * tempScore + 0.2 * humScore + 0.2 * windScore + 0.1 * rainScore
  );
}

function scoreAir(pm25, pm10, aqi) {
  let pm25Score;
  if (!Number.isFinite(pm25)) pm25Score = 50;
  else if (pm25 <= 5) pm25Score = 100;
  else if (pm25 >= 50) pm25Score = 0;
  else pm25Score = ((50 - pm25) / (50 - 5)) * 100;

  let pm10Score;
  if (!Number.isFinite(pm10)) pm10Score = 50;
  else if (pm10 <= 15) pm10Score = 100;
  else if (pm10 >= 100) pm10Score = 0;
  else pm10Score = ((100 - pm10) / (100 - 15)) * 100;

  let aqiScore;
  if (!Number.isFinite(aqi)) aqiScore = 50;
  else {
    const clamped = Math.min(5, Math.max(1, aqi));
    aqiScore = 100 - (clamped - 1) * 25;
  }

  return Math.round(0.4 * pm25Score + 0.3 * pm10Score + 0.3 * aqiScore);
}

function computeWalkSummary(agg) {
  if (!agg || agg.count === 0) return null;

  const durationMin = (agg.endTs - agg.startTs) / 1000 / 60;

  const avgNoiseDbfs = agg.noiseSum / agg.count;
  const avgTempC = agg.tempSum / agg.count;
  const avgHumidity = agg.humiditySum / agg.count;
  const avgWind = agg.windSum / agg.count;
  const avgPrecip = agg.precipSum / agg.count;
  const avgPm25 = agg.pm25Sum / agg.count;
  const avgPm10 = agg.pm10Sum / agg.count;
  const avgAqi = agg.aqiSum / agg.count;

  const noiseScore = scoreNoise(avgNoiseDbfs);
  const weatherScore = scoreWeather(
    avgTempC,
    avgHumidity,
    avgWind,
    avgPrecip
  );
  const airScore = scoreAir(avgPm25, avgPm10, avgAqi);

  const walkScore = Math.round(
    0.4 * noiseScore + 0.3 * weatherScore + 0.3 * airScore
  );

  return {
    durationMin,
    avgNoiseDbfs,
    avgTempC,
    avgHumidity,
    avgWind,
    avgPrecip,
    avgPm25,
    avgPm10,
    avgAqi,
    noiseScore,
    weatherScore,
    airScore,
    walkScore,
  };
}

// ---------------------------------------------------------------------------
// RECORD / STOP LOGIC
// ---------------------------------------------------------------------------
recordButton.addEventListener("click", () => {
  if (!isRecording) startRecording();
  else stopRecording();
});

async function startRecording() {
  if (!currentUser) {
    alert("Please login first.");
    return;
  }
  if (isRecording) return;

  isRecording = true;
  recordButton.textContent = "Stop";
  recordButton.classList.add("recording");
  recordStatus.textContent = "Preparing sensors…";
  quickAnalyticsButton.hidden = true;
  lastCompletedSessionId = null;

  try {
    await getCurrentPositionOnce();
    await Promise.all([
      fetchWeather(lastPos.lat, lastPos.lon),
      fetchAir(lastPos.lat, lastPos.lon),
    ]);

    const sessionsCol = collection(db, "users", currentUser.uid, "sessions");
    const sessionDoc = doc(sessionsCol);
    currentSessionRef = sessionDoc;
    totalReadings = 0;

    const locNamePromise = reverseGeocode(lastPos.lat, lastPos.lon);

    await setDoc(sessionDoc, {
      startedAt: serverTimestamp(),
      status: "running",
    });

    resetAggregator();
    currentAgg.startTs = Date.now();
    await startMic();
    startGpsWatch();

    flushTimerId = setInterval(flushOneSecond, 1000);
    weatherTimerId = setInterval(
      () => fetchWeather(lastPos.lat, lastPos.lon),
      15 * 60 * 1000
    );
    airTimerId = setInterval(
      () => fetchAir(lastPos.lat, lastPos.lon),
      60 * 60 * 1000
    );

    locNamePromise.then((name) => {
      updateDoc(sessionDoc, { locationName: name }).catch(console.error);
    });

    recordStatus.textContent = "Recording… Tap Stop when your walk is done.";
  } catch (err) {
    console.error("Start recording failed", err);
    alert("Could not start sensors. Please check permissions.");
    await stopRecording(true);
  }
}

async function stopRecording(isError = false) {
  if (!isRecording) return;
  isRecording = false;
  recordButton.textContent = "Record";
  recordButton.classList.remove("recording");

  clearInterval(flushTimerId);
  clearInterval(weatherTimerId);
  clearInterval(airTimerId);
  flushTimerId = weatherTimerId = airTimerId = null;

  stopMic();
  stopGpsWatch();

  if (!currentSessionRef || !currentAgg) {
    recordStatus.textContent = "Stopped.";
    return;
  }

  currentAgg.endTs = Date.now();
  const summary = computeWalkSummary(currentAgg);

  try {
    await updateDoc(currentSessionRef, {
      endedAt: serverTimestamp(),
      status: isError ? "error" : "completed",
      totalReadings: totalReadings,
      summary: clean(summary),
    });
  } catch (err) {
    console.error("Failed to update session summary", err);
  }

  if (!isError) {
    recordStatus.textContent = "Walk saved. View analytics for details.";
    lastCompletedSessionId = currentSessionRef.id;
    quickAnalyticsButton.hidden = false;
    await loadPastWalksForUser(currentUser.uid);
  } else {
    recordStatus.textContent = "Recording stopped due to an error.";
  }

  currentSessionRef = null;
  currentAgg = null;
}

// Flush once per second to Firestore
async function flushOneSecond() {
  if (!currentSessionRef) return;
  if (!countDB || !lastPos || !wxCache.weather || !wxCache.air) return;

  const avgDB = sumDB / countDB;
  sumDB = 0;
  countDB = 0;

  const reading = {
    ts: Timestamp.fromDate(new Date()),
    lat: lastPos.lat,
    lon: lastPos.lon,
    accuracy_m: lastPos.acc,
    sound_dbfs: avgDB,
    weather: wxCache.weather,
    air: wxCache.air,
  };

  try {
    await addDoc(
      collection(currentSessionRef, "readings"),
      clean(reading)
    );
    totalReadings += 1;
  } catch (err) {
    console.error("Failed to write reading", err);
  }

  currentAgg.count += 1;
  currentAgg.noiseSum += avgDB;

  const w = wxCache.weather;
  const a = wxCache.air;
  if (w) {
    currentAgg.tempSum += w.temperature_2m ?? 0;
    currentAgg.humiditySum += w.relative_humidity_2m ?? 0;
    currentAgg.windSum += w.wind_speed_10m ?? 0;
    currentAgg.precipSum += w.precipitation ?? 0;
  }
  if (a) {
    currentAgg.pm25Sum += a.pm2_5 ?? 0;
    currentAgg.pm10Sum += a.pm10 ?? 0;
    currentAgg.aqiSum += a.european_aqi ?? 0;
  }
}

// ---------------------------------------------------------------------------
// PAST WALKS TABLE
// ---------------------------------------------------------------------------
async function loadPastWalksForUser(uid) {
  const sessionsCol = collection(db, "users", uid, "sessions");
  const q = query(sessionsCol, orderBy("startedAt", "desc"));
  const snap = await getDocs(q);

  userSessionsCache = [];
  walksTableBody.innerHTML = "";

  let i = 1;
  snap.forEach((docSnap) => {
    const data = docSnap.data();
    userSessionsCache.push({ id: docSnap.id, data });

    const tr = document.createElement("tr");

    const idxTd = document.createElement("td");
    idxTd.textContent = String(i++);
    tr.appendChild(idxTd);

    const startedAt = toJsDateMaybe(data.startedAt);
    const dateTd = document.createElement("td");
    dateTd.textContent = startedAt
      ? startedAt.toLocaleString()
      : "--";
    tr.appendChild(dateTd);

    const locTd = document.createElement("td");
    locTd.textContent = data.locationName || "--";
    tr.appendChild(locTd);

    const scoreTd = document.createElement("td");
    const score =
      data.summary && typeof data.summary.walkScore === "number"
        ? `${data.summary.walkScore}%`
        : "--";
    scoreTd.textContent = score;
    tr.appendChild(scoreTd);

    const detailTd = document.createElement("td");
    const btn = document.createElement("button");
    btn.textContent = "View";
    btn.className = "table-view-btn";
    btn.addEventListener("click", () =>
      openAnalyticsForSession(docSnap.id)
    );
    detailTd.appendChild(btn);
    tr.appendChild(detailTd);

    walksTableBody.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// PER-WALK ANALYTICS (Chart.js + summary)
// ---------------------------------------------------------------------------
async function openAnalyticsForSession(sessionId) {
  if (!currentUser) return;

  const sessionRef = doc(
    db,
    "users",
    currentUser.uid,
    "sessions",
    sessionId
  );
  const sessionSnap = await getDoc(sessionRef);
  if (!sessionSnap.exists()) {
    alert("Session not found.");
    return;
  }

  const data = sessionSnap.data();
  const startedAt = toJsDateMaybe(data.startedAt);
  const summary = data.summary || {};

  analyticsTitle.textContent = "Walk Analytics";
  analyticsSubtitle.textContent = startedAt
    ? `Walk on ${startedAt.toLocaleString()}`
    : "";

  locNameEl.textContent = `Location: ${data.locationName || "--"}`;
  walkDurationEl.textContent = summary.durationMin
    ? `Duration: ${summary.durationMin.toFixed(1)} min`
    : "Duration: --";
  walkStartedAtEl.textContent = startedAt
    ? `Started: ${startedAt.toLocaleTimeString()}`
    : "Started: --";

  if (summary.walkScore != null) {
    const s = summary.walkScore;
    const label =
      s >= 80 ? "Excellent" : s >= 60 ? "Good" : s >= 40 ? "OK" : "Poor";
    walkScoreTextEl.textContent = `Walk Score: ${summary.walkScore}% (${label})`;
  } else {
    walkScoreTextEl.textContent = "Walk Score: --";
  }

  avgTempEl.textContent = `Temperature: ${fmt(
    summary.avgTempC,
    1
  )} °C`;
  avgHumidityEl.textContent = `Humidity: ${fmt(
    summary.avgHumidity,
    0
  )} %`;
  avgWindEl.textContent = `Wind: ${fmt(summary.avgWind, 1)} m/s`;
  avgPrecipEl.textContent = `Precipitation: ${fmt(
    summary.avgPrecip,
    1
  )} mm`;
  weatherScoreTextEl.textContent =
    summary.weatherScore != null
      ? `Weather Score: ${summary.weatherScore}%`
      : "Weather Score: --";

  avgPm25El.textContent = `PM2.5: ${fmt(summary.avgPm25, 1)} µg/m³`;
  avgPm10El.textContent = `PM10: ${fmt(summary.avgPm10, 1)} µg/m³`;
  avgAqiEl.textContent = `EU AQI: ${fmt(summary.avgAqi, 0)}`;
  airScoreTextEl.textContent =
    summary.airScore != null
      ? `Air Score: ${summary.airScore}%`
      : "Air Score: --";

  const readingsSnap = await getDocs(
    query(
      collection(sessionRef, "readings"),
      orderBy("ts", "asc")
    )
  );

  const labels = [];
  const noiseSeries = [];

  readingsSnap.forEach((rSnap) => {
    const r = rSnap.data();
    const ts = r.ts ? toJsDateMaybe(r.ts) : null;
    labels.push(
      ts ? ts.toLocaleTimeString([], { hour12: false }) : ""
    );
    noiseSeries.push(r.sound_dbfs ?? null);
  });

  if (micChart) micChart.destroy();
  micChart = new Chart(micCanvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Noise (dBFS)",
          data: noiseSeries,
          borderWidth: 2,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          title: { display: true, text: "dBFS (lower is quieter)" },
        },
      },
    },
  });

  showView("analytics");
}

backFromAnalytics.addEventListener("click", () => {
  showView("home");
});

quickAnalyticsButton.addEventListener("click", () => {
  if (lastCompletedSessionId) openAnalyticsForSession(lastCompletedSessionId);
});

// ---------------------------------------------------------------------------
// HISTORY ANALYTICS
// ---------------------------------------------------------------------------
historyAnalyticsButton.addEventListener("click", () => {
  renderHistoryAnalytics();
  showView("history");
});

backFromHistory.addEventListener("click", () => {
  showView("home");
});

function renderHistoryAnalytics() {
  const sessions = userSessionsCache.filter(
    (s) => s.data.summary && typeof s.data.summary.walkScore === "number"
  );
  if (!sessions.length) {
    historySummaryText.textContent =
      "No completed walks yet. Go for a walk and record it!";
    if (historyScoreChart) historyScoreChart.destroy();
    if (historyAvgChart) historyAvgChart.destroy();
    return;
  }

  const labels = [];
  const scores = [];
  let noiseSum = 0,
    weatherSum = 0,
    airSum = 0;

  sessions
    .slice()
    .sort((a, b) => {
      const da = toJsDateMaybe(a.data.startedAt)?.getTime() || 0;
      const db = toJsDateMaybe(b.data.startedAt)?.getTime() || 0;
      return da - db;
    })
    .forEach((s) => {
      const d = s.data;
      const startedAt = toJsDateMaybe(d.startedAt);
      labels.push(
        startedAt
          ? startedAt.toLocaleDateString() +
              " " +
              startedAt.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })
          : s.id
      );

      const sum = d.summary;
      scores.push(sum.walkScore);
      noiseSum += sum.noiseScore ?? 0;
      weatherSum += sum.weatherScore ?? 0;
      airSum += sum.airScore ?? 0;
    });

  const n = sessions.length;
  const avgNoise = noiseSum / n;
  const avgWeather = weatherSum / n;
  const avgAir = airSum / n;

  historySummaryText.textContent = `You have recorded ${n} walk${
    n === 1 ? "" : "s"
  }. Your average walk score is ${(
    scores.reduce((a, b) => a + b, 0) / n
  ).toFixed(1)}%.`;

  if (historyScoreChart) historyScoreChart.destroy();
  historyScoreChart = new Chart(
    historyScoreCanvas.getContext("2d"),
    {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Walk Score (%)",
            data: scores,
            borderWidth: 2,
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            min: 0,
            max: 100,
            title: { display: true, text: "Score (%)" },
          },
        },
      },
    }
  );

  if (historyAvgChart) historyAvgChart.destroy();
  historyAvgChart = new Chart(
    historyAvgCanvas.getContext("2d"),
    {
      type: "bar",
      data: {
        labels: ["Noise", "Weather", "Air"],
        datasets: [
          {
            label: "Average Score (%)",
            data: [avgNoise, avgWeather, avgAir],
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            min: 0,
            max: 100,
          },
        },
      },
    }
  );
}

// ---------------------------------------------------------------------------
// RECOMMENDATIONS – BEST TIME TODAY / TOMORROW
// ---------------------------------------------------------------------------
todayRecButton.addEventListener("click", () => {
  toggleRecommendation("today");
});
tomorrowRecButton.addEventListener("click", () => {
  toggleRecommendation("tomorrow");
});

async function toggleRecommendation(which) {
  if (!recommendationSection) return;

  // Clicking the same button again hides the card
  if (
    currentRecMode === which &&
    !recommendationSection.classList.contains("hidden")
  ) {
    recommendationSection.classList.add("hidden");
    currentRecMode = null;
    return;
  }

  await computeRecommendations(which);
}

async function fetchHourlyForecast(lat, lon) {
  const base = `latitude=${lat}&longitude=${lon}&timezone=auto`;

  const weatherUrl =
    `https://api.open-meteo.com/v1/forecast?${base}` +
    "&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation&forecast_days=2";

  const airUrl =
    `https://air-quality-api.open-meteo.com/v1/air-quality?${base}` +
    "&hourly=pm2_5,pm10,european_aqi&forecast_days=2";

  const [wRes, aRes] = await Promise.all([
    fetch(weatherUrl),
    fetch(airUrl),
  ]);
  const weather = await wRes.json();
  const air = await aRes.json();
  return { weather, air };
}

function buildHourlyScores(forecast) {
  const { weather, air } = forecast;
  const times = weather.hourly.time;
  const scores = [];

  for (let i = 0; i < times.length; i++) {
    const temp = weather.hourly.temperature_2m[i];
    const hum = weather.hourly.relative_humidity_2m[i];
    const wind = weather.hourly.wind_speed_10m[i];
    const precip = weather.hourly.precipitation[i];

    const pm25 = air.hourly.pm2_5[i];
    const pm10 = air.hourly.pm10[i];
    const aqi = air.hourly.european_aqi[i];

    const weatherScore = scoreWeather(temp, hum, wind, precip);
    const airScore = scoreAir(pm25, pm10, aqi);
    const walkScore = Math.round(0.5 * weatherScore + 0.5 * airScore);

    scores.push({
      timeIso: times[i],
      walkScore,
      weatherScore,
      airScore,
      temp,
      hum,
      wind,
      precip,
      pm25,
      pm10,
      aqi,
    });
  }
  return scores;
}

function bestSlotForDate(hourlyScores, dateStr) {
  const filtered = hourlyScores.filter((h) => {
    const d = h.timeIso.slice(0, 10);
    const hour = new Date(h.timeIso).getHours();
    return d === dateStr && hour >= 5 && hour <= 22;
  });
  if (!filtered.length) return null;
  filtered.sort((a, b) => b.walkScore - a.walkScore);
  return filtered[0];
}

function bestSlotFromNowToday(hourlyScores, now) {
  const todayStr = now.toISOString().slice(0, 10);
  const nowMs = now.getTime();

  const filtered = hourlyScores.filter((h) => {
    const d = h.timeIso.slice(0, 10);
    if (d !== todayStr) return false;
    const ts = new Date(h.timeIso).getTime();
    const hour = new Date(h.timeIso).getHours();
    return ts >= nowMs && hour >= 5 && hour <= 22;
  });

  if (!filtered.length) return null;
  filtered.sort((a, b) => b.walkScore - a.walkScore);
  return filtered[0];
}

async function computeRecommendations(which) {
  if (!lastPos) {
    try {
      await getCurrentPositionOnce();
    } catch {
      alert("Need location permission for recommendations.");
      return;
    }
  }

  try {
    const forecast = await fetchHourlyForecast(lastPos.lat, lastPos.lon);
    const hourlyScores = buildHourlyScores(forecast);

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);

    const todayBestOverall = bestSlotForDate(hourlyScores, todayStr);
    const todayBestRemaining = bestSlotFromNowToday(hourlyScores, now);
    const tomorrowBest = bestSlotForDate(hourlyScores, tomorrowStr);

    if (which === "today") {
      renderRecommendationToday(todayBestOverall, todayBestRemaining);
    } else {
      renderRecommendationTomorrow(tomorrowBest);
    }

    if (recommendationSection)
      recommendationSection.classList.remove("hidden");
    currentRecMode = which;
  } catch (err) {
    console.error("Recommendation error", err);
    alert("Could not fetch forecast. Try again later.");
  }
}

function renderRecommendationToday(bestOverall, bestRemaining) {
  if (!recommendCard) return;

  if (!bestOverall) {
    recommendCard.textContent = "No suitable time found for today.";
    return;
  }

  const tOverall = formatTimeShort(bestOverall.timeIso);

  let html = `
    <div class="recommend-card-title">Today’s Recommendation</div>
    <div class="rec-row">
      <span class="rec-label">Best time today:</span>
      <span> ${tOverall}</span>
    </div>
    <div class="rec-row">
      <span class="rec-label">Predicted walk score:</span>
      <span> ${bestOverall.walkScore}% (Weather ${bestOverall.weatherScore}%, Air ${bestOverall.airScore}%)</span>
    </div>
    <div class="rec-row">
      <span class="rec-label">Weather:</span>
      <span>
        Temp ${fmt(bestOverall.temp, 1)} °C,
        Humidity ${fmt(bestOverall.hum, 0)} %,
        Wind ${fmt(bestOverall.wind, 1)} m/s
      </span>
    </div>
    <div class="rec-row">
      <span class="rec-label">Air quality:</span>
      <span>
        PM2.5 ${fmt(bestOverall.pm25, 1)} µg/m³,
        PM10 ${fmt(bestOverall.pm10, 1)} µg/m³,
        EU AQI ${fmt(bestOverall.aqi, 0)}
      </span>
    </div>
  `;

  // If best overall time is in the past, also show "best for rest of today"
  if (bestRemaining && bestRemaining.timeIso !== bestOverall.timeIso) {
    const tRem = formatTimeShort(bestRemaining.timeIso);

    html += `
      <hr class="rec-divider">
      <div class="rec-row">
        <span class="rec-label">Best time for the rest of today:</span>
        <span> ${tRem}</span>
      </div>
      <div class="rec-row">
        <span class="rec-label">Predicted walk score:</span>
        <span> ${bestRemaining.walkScore}% (Weather ${bestRemaining.weatherScore}%, Air ${bestRemaining.airScore}%)</span>
      </div>
      <div class="rec-row">
        <span class="rec-label">Weather:</span>
        <span>
          Temp ${fmt(bestRemaining.temp, 1)} °C,
          Humidity ${fmt(bestRemaining.hum, 0)} %,
          Wind ${fmt(bestRemaining.wind, 1)} m/s
        </span>
      </div>
      <div class="rec-row">
        <span class="rec-label">Air quality:</span>
        <span>
          PM2.5 ${fmt(bestRemaining.pm25, 1)} µg/m³,
          PM10 ${fmt(bestRemaining.pm10, 1)} µg/m³,
          EU AQI ${fmt(bestRemaining.aqi, 0)}
        </span>
      </div>
    `;
  }

  recommendCard.innerHTML = html;
}


function renderRecommendationTomorrow(best) {
  if (!recommendCard) return;

  if (!best) {
    recommendCard.textContent = "No suitable time found for tomorrow.";
    return;
  }

  const t = formatTimeShort(best.timeIso);

  const html = `
    <div class="recommend-card-title">Tomorrow’s Recommendation</div>
    <div class="rec-row">
      <span class="rec-label">Best time tomorrow:</span>
      <span> ${t}</span>
    </div>
    <div class="rec-row">
      <span class="rec-label">Predicted walk score:</span>
      <span> ${best.walkScore}% (Weather ${best.weatherScore}%, Air ${best.airScore}%)</span>
    </div>
    <div class="rec-row">
      <span class="rec-label">Weather:</span>
      <span>
        Temp ${fmt(best.temp, 1)} °C,
        Humidity ${fmt(best.hum, 0)} %,
        Wind ${fmt(best.wind, 1)} m/s
      </span>
    </div>
    <div class="rec-row">
      <span class="rec-label">Air quality:</span>
      <span>
        PM2.5 ${fmt(best.pm25, 1)} µg/m³,
        PM10 ${fmt(best.pm10, 1)} µg/m³,
        EU AQI ${fmt(best.aqi, 0)}
      </span>
    </div>
  `;

  recommendCard.innerHTML = html;
}


// ---------------------------------------------------------------------------
// INITIAL STATE
// ---------------------------------------------------------------------------
showView("home");
recordStatus.textContent = "Please login to start.";
