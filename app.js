import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
  getFirestore, doc, setDoc, collection, addDoc,
  serverTimestamp, Timestamp, updateDoc
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

//FIREBASE INIT
const firebaseConfig = {
  apiKey: "AIzaSyAhw_Q8LwkTA_MhsCX-SsKST5zSA2wdwSo",
  authDomain: "walkguide-68d15.firebaseapp.com",
  projectId: "walkguide-68d15",
  storageBucket: "walkguide-68d15.firebasestorage.app",
  messagingSenderId: "873504166739",
  appId: "1:873504166739:web:6fbfe0970dad0dff45c7a6",
  measurementId: "G-KKYHPNVW7J"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
await setPersistence(auth, browserLocalPersistence).catch(console.error);
const db = getFirestore(app);

//DOM GETTERS
const $ = id => document.getElementById(id);

const micEl = $("micDisplay");
const locEl = $("locationDisplay");
const accEl = $("accuracyDisplay");

const tempEl   = $("tempDisplay");
const humEl    = $("humDisplay");
const windEl   = $("windDisplay");
const precipEl = $("precipDisplay");
const wxTimeEl = $("weatherTime");

const pm25El   = $("pm25Display");
const pm10El   = $("pm10Display");
const aqiEl    = $("aqiDisplay");
const airTimeEl= $("airTime");

const startBtn = $("start");
const stopBtn  = $("stop");
const statusEl = $("status");
const progressEl = $("progress");

//HELPERS
function clean(obj) {
  if (Array.isArray(obj)) {
    return obj.map(clean).filter(v => !(v == null || (typeof v === "number" && !Number.isFinite(v)) || v === ""));
  }
  if (obj && typeof obj === "object") {
    const o = {};
    for (const [k, v] of Object.entries(obj)) {
      const vv = clean(v);
      if (!(vv == null || (typeof vv === "number" && !Number.isFinite(vv)) || vv === "")) o[k] = vv;
    }
    return o;
  }
  return obj;
}

const fmt  = (n, d) => Number.isFinite(n) ? Number(n).toFixed(d) : "--";
const dbfs = rms => 20 * Math.log10(Math.max(rms, 1e-12));

//MIC STATE
const MIC_WARMUP_MS = 1200;
const MIN_DBFS = -100;
const MAX_DBFS = 0;

let micBuf = new Float32Array(2048);
let stream, ctx, ana, src, raf;
let micStartAt = 0;
let sumDB = 0, countDB = 0, bucketStart = 0;

//GPS & REFRESH CADENCE
let gpsWatchId = null;
let lastPos = null;

const FLUSH_PERIOD_MS   = 1000;                 // save sensors every second
const WX_REFRESH_MS     = 15 * 60 * 1000;       // 15 minutes
const AIR_REFRESH_MS    = 60 * 60 * 1000;       // 1 hour

let flushTimer   = null;
let refreshTimer = null; // checks if either API is due
let logging = false;

//WEATHER / AIR CACHE 
let weatherCache = { data: null, fetchedAt: 0 };
let airCache     = { data: null, fetchedAt: 0 };

//SESSION STORAGE
let currentUID = null;
let session = { id: null, startedAt: null, endedAt: null, totalReadings: 0 };
let sessionDocRef = null;
let readingsColRef = null;

//AUTH
signInAnonymously(auth).catch(console.error);
onAuthStateChanged(auth, user => { currentUID = user ? user.uid : null; });

//MICROPHONE SAMPLE LOOP
function sampleMic() {
  if (!ana) return;

  ana.getFloatTimeDomainData(micBuf);
  let s = 0;
  for (let i = 0; i < micBuf.length; i++) s += micBuf[i] * micBuf[i];
  const rms = Math.sqrt(s / micBuf.length);
  const vdb = dbfs(rms);

  micEl.textContent = `${fmt(vdb, 1)} dBFS`;

  const now = performance.now();
  const warmed = (now - micStartAt) >= MIC_WARMUP_MS;
  if (!bucketStart) bucketStart = now;

  if (warmed && Number.isFinite(vdb) && vdb >= MIN_DBFS && vdb <= MAX_DBFS) {
    sumDB += vdb;
    countDB++;
  }

  if (logging) raf = requestAnimationFrame(sampleMic);
}

//GPS HANDLING
function startGPS() {
  gpsWatchId = navigator.geolocation.watchPosition(pos => {
    const { latitude, longitude, accuracy } = pos.coords;
    lastPos = { lat: latitude, lon: longitude, acc: accuracy };
    locEl.textContent = `${fmt(latitude, 6)}, ${fmt(longitude, 6)}`;
    accEl.textContent = `${fmt(accuracy, 1)} m`;
  }, _err => {
    locEl.textContent = "Location Error";
  }, { enableHighAccuracy: true, timeout: 10000 });
}

function stopGPS() {
  if (gpsWatchId) navigator.geolocation.clearWatch(gpsWatchId);
}

function getCurrentPositionOnce() {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000 })
  );
}

//WEATHER / AIR API
async function fetchWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,cloud_cover&timezone=auto`;
  const json = await fetch(url).then(r => r.json());
  return json.current || null;
}

async function fetchAir(lat, lon) {
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    `&current=pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,european_aqi&timezone=auto`;
  const json = await fetch(url).then(r => r.json());
  return json.current || null;
}

function updateWeatherUI(w) {
  if (!w) return;
  tempEl.textContent   = `${fmt(w.temperature_2m, 1)} °C`;
  humEl.textContent    = `${fmt(w.relative_humidity_2m, 0)} %`;
  windEl.textContent   = `${fmt(w.wind_speed_10m, 1)} m/s`;
  precipEl.textContent = `${fmt(w.precipitation, 1)} mm`;
  wxTimeEl.textContent = `Last update: ${w.time || "--"}`;
}

function updateAirUI(a) {
  if (!a) return;
  pm25El.textContent = `${fmt(a.pm2_5, 1)} µg/m³`;
  pm10El.textContent = `${fmt(a.pm10, 1)} µg/m³`;
  aqiEl.textContent   = fmt(a.european_aqi, 0);
  airTimeEl.textContent = `Last update: ${a.time || "--"}`;
}

//PERIODIC REFRESH (15m / 1h)
async function refreshExternalIfDue() {
  if (!lastPos) return;

  const now = Date.now();

  //Weather every 15 minutes
  if (now - weatherCache.fetchedAt >= WX_REFRESH_MS) {
    try {
      const w = await fetchWeather(lastPos.lat, lastPos.lon);
      if (w) {
        weatherCache = { data: w, fetchedAt: now };
        updateWeatherUI(w);
      }
    } catch (e) {
      console.error("Weather refresh failed:", e);
    }
  }

  //Air quality every 1 hour
  if (now - airCache.fetchedAt >= AIR_REFRESH_MS) {
    try {
      const a = await fetchAir(lastPos.lat, lastPos.lon);
      if (a) {
        airCache = { data: a, fetchedAt: now };
        updateAirUI(a);
      }
    } catch (e) {
      console.error("Air refresh failed:", e);
    }
  }
}

//DATA SAVE PER SECOND
async function flushOneSecond() {
  //need 1s mic avg + gps + both weather & air snapshots
  if (!countDB || !lastPos || !weatherCache.data || !airCache.data || !sessionDocRef) return;

  const avgDB = sumDB / countDB;
  sumDB = 0; countDB = 0;

  await addDoc(readingsColRef, clean({
    ts: Timestamp.fromDate(new Date()),
    lat: lastPos.lat,
    lon: lastPos.lon,
    accuracy_m: lastPos.acc,
    sound_dbfs: avgDB,
    weather: weatherCache.data,
    air: airCache.data
  }));
  session.totalReadings++;
  progressEl.textContent = `Saved ${session.totalReadings} readings…`;
}

//START
async function start() {
  if (!currentUID) { progressEl.textContent = "Signing in…"; return; }
  if (!navigator.geolocation) { progressEl.textContent = "GPS Not Available"; return; }

  session = { id: null, startedAt: new Date(), endedAt: null, totalReadings: 0 };

  const sessionsCol = collection(db, "users", currentUID, "sessions");
  sessionDocRef = doc(sessionsCol);
  readingsColRef = collection(sessionDocRef, "readings");

  await setDoc(sessionDocRef, clean({
    startedAt: Timestamp.fromDate(session.startedAt),
    samplePeriodMs: FLUSH_PERIOD_MS,
    weatherRefreshMs: WX_REFRESH_MS,
    airRefreshMs: AIR_REFRESH_MS,
    device: { userAgent: navigator.userAgent, platform: navigator.platform },
    createdAt: serverTimestamp()
  }));

  //Initial GPS
  progressEl.textContent = "Getting GPS Fix…";
  const first = await getCurrentPositionOnce();
  lastPos = { lat: first.coords.latitude, lon: first.coords.longitude, acc: first.coords.accuracy };
  locEl.textContent = `${fmt(lastPos.lat,6)}, ${fmt(lastPos.lon,6)}`;
  accEl.textContent = `${fmt(lastPos.acc,1)} m`;

  //Initial Weather + Air: wait before logging
  progressEl.textContent = "Fetching Weather & Air…";
  const [w0, a0] = await Promise.all([
    fetchWeather(lastPos.lat, lastPos.lon),
    fetchAir(lastPos.lat, lastPos.lon)
  ]);
  weatherCache = { data: w0, fetchedAt: Date.now() };
  airCache     = { data: a0, fetchedAt: Date.now() };
  updateWeatherUI(w0);
  updateAirUI(a0);

  //Start continuous GPS + Mic + timers
  startGPS();

  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  ana = ctx.createAnalyser(); ana.fftSize = 2048;
  src = ctx.createMediaStreamSource(stream); src.connect(ana);
  micStartAt = performance.now();

  logging = true;
  sampleMic();

  flushTimer   = setInterval(flushOneSecond, FLUSH_PERIOD_MS);
  refreshTimer = setInterval(refreshExternalIfDue, 10_000);

  statusEl.textContent = "Running…";
  statusEl.classList.remove("stopped"); statusEl.classList.add("running");
  startBtn.disabled = true; stopBtn.disabled = false;
  progressEl.textContent = `Session ${sessionDocRef.id} started`;
}

//STOP
async function stop() {
  logging = false;
  if (raf) cancelAnimationFrame(raf);
  if (flushTimer)   clearInterval(flushTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  stopGPS();

  try { src && src.disconnect(); } catch {}
  try { ctx && ctx.close(); } catch {}
  try { stream && stream.getTracks().forEach(t => t.stop()); } catch {}

  //final flush if we have a partial bucket
  await flushOneSecond();

  session.endedAt = new Date();
  await updateDoc(sessionDocRef, clean({
    endedAt: Timestamp.fromDate(session.endedAt),
    totalReadings: session.totalReadings,
    updatedAt: serverTimestamp()
  }));

  progressEl.textContent = `Session Complete (${session.totalReadings} readings).`;

  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusEl.textContent = "Stopped";
  statusEl.classList.remove("running"); statusEl.classList.add("stopped");
}

//EVENT HOOKS
startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);