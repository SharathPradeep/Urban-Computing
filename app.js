import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
  getFirestore, doc, setDoc, collection, addDoc,
  serverTimestamp, Timestamp, updateDoc
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

//Firebase
const firebaseConfig = {
  apiKey: "AIzaSyAhw_Q8LwkTA_MhsCX-SsKST5zSA2wdwSo",
  authDomain: "walkguide-68d15.firebaseapp.com",
  projectId: "walkguide-68d15",
  storageBucket: "walkguide-68d15.firebasestorage.app",
  messagingSenderId: "873504166739",
  appId: "1:873504166739:web:6fbfe0970dad0dff45c7a6",
  measurementId: "G-KKYHPNVW7J"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
await setPersistence(auth, browserLocalPersistence).catch(console.error);
const db   = getFirestore(app);

//DOM
const $ = id => document.getElementById(id);
const statusEl  = $('status');
const micEl     = $('micDisplay');
const locEl     = $('locationDisplay');
const wxEl      = $('weatherDisplay');
const airEl     = $('airDisplay');
const startBtn  = $('start');
const stopBtn   = $('stop');
const progressEl= $('progress');

//Helpers
//Strip undefined/null/NaN/"" recursively before Firestore write
function clean(obj) {
  if (Array.isArray(obj)) {
    return obj.map(clean).filter(v =>
      !(v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v)) || v === '')
    );
  }
  if (obj && typeof obj === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(obj)) {
      const vv = clean(v);
      if (!(vv === undefined || vv === null || (typeof vv === 'number' && !Number.isFinite(vv)) || vv === '')) {
        o[k] = vv;
      }
    }
    return o;
  }
  return obj;
}
const fmt  = (n, d) => Number.isFinite(n) ? Number(n).toFixed(d) : '';
const dbfs = rms => 20 * Math.log10(Math.max(rms, 1e-12));
const sleep = ms => new Promise(r => setTimeout(r, ms));

//Mic outlier filter
const MIC_WARMUP_MS = 1200;   //ignore first ~1.2 s of mic samples
const MIN_DBFS      = -100;   //ignore readings below this (startup spikes)
const MAX_DBFS      = 0;      //sanity upper bound for dBFS

//Sensor state
let stream, ctx, ana, src, raf;
let gpsWatchId = null, logging = false;
const micBuf = new Float32Array(2048);

//1-second mic averaging bucket
let bucketStart = 0;
let sumDB = 0;
let countDB = 0;
let micStartAt = 0;

//latest GPS fix
let lastPos = null;

//timers
const FLUSH_PERIOD_MS  = 1000;
const WEATHER_PERIOD_MS= 60000;
let flushTimer = null;
let weatherTimer = null;

//Weather/AQ cache
let wxCache = {
  fetchedAt: 0,  // ms
  weather: null, // { temperature_2m, relative_humidity_2m, wind_speed_10m, ... }
  air: null      // { pm2_5, pm10, ozone, nitrogen_dioxide, sulphur_dioxide, european_aqi, ... }
};

//Session
let currentUID = null;
let session = { id: null, startedAt: null, endedAt: null, totalReadings: 0 };
let sessionDocRef = null;
let readingsColRef = null;

//Auth
signInAnonymously(auth).catch(console.error);
onAuthStateChanged(auth, user => { currentUID = user ? user.uid : null; });

//Mic sampler
function sampleMic() {
  if (!ana) return;

  ana.getFloatTimeDomainData(micBuf);
  let s = 0;
  for (let i = 0; i < micBuf.length; i++) s += micBuf[i] * micBuf[i];
  const rms = Math.sqrt(s / micBuf.length);
  const vdb = dbfs(rms);

  //UI: 1 decimal place
  micEl.textContent = `Mic: ${vdb.toFixed(1)} dBFS`;

  //Accumulate (1s) only if warmed + sane
  const now = performance.now();
  const warmed = (now - micStartAt) >= MIC_WARMUP_MS;
  if (!bucketStart) bucketStart = now;

  if (warmed && Number.isFinite(vdb) && vdb >= MIN_DBFS && vdb <= MAX_DBFS) {
    sumDB += vdb;
    countDB += 1;
  }

  if (logging) raf = requestAnimationFrame(sampleMic);
}

//GPS
function startGPS() {
  const opts = { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 };
  gpsWatchId = navigator.geolocation.watchPosition(pos => {
    const { latitude: lat, longitude: lon, accuracy: acc } = pos.coords;
    lastPos = { lat, lon, acc };
    locEl.textContent = `Location: ${fmt(lat,6)}, ${fmt(lon,6)} (±${fmt(acc,1)}m)`;
  }, err => {
    locEl.textContent = `Location: Error - ${err.message}`;
  }, opts);
}
function stopGPS() {
  if (gpsWatchId != null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
}
function getCurrentPositionOnce(opts={ enableHighAccuracy:true, maximumAge:0, timeout:15000 }) {
  return new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, opts));
}

//Open-Meteo fetch
async function fetchOpenMeteo(lat, lon) {
  //Weather current fields
  const weatherURL = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,cloud_cover` +
    `&timezone=auto`;

  //Air Quality current fields
  const aqURL = `https://air-quality-api.open-meteo.com/v1/air-quality` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,european_aqi` +
    `&timezone=auto`;

  const [wResp, aResp] = await Promise.all([
    fetch(weatherURL),
    fetch(aqURL)
  ]);

  const w = await wResp.json();
  const a = await aResp.json();

  const weather = w?.current ? {
    time_iso: w.current.time,
    temperature_2m: w.current.temperature_2m,
    relative_humidity_2m: w.current.relative_humidity_2m,
    wind_speed_10m: w.current.wind_speed_10m,
    precipitation: w.current.precipitation,
    cloud_cover: w.current.cloud_cover
  } : null;

  const air = a?.current ? {
    time_iso: a.current.time,
    pm2_5: a.current.pm2_5,
    pm10: a.current.pm10,
    ozone: a.current.ozone,
    nitrogen_dioxide: a.current.nitrogen_dioxide,
    sulphur_dioxide: a.current.sulphur_dioxide,
    european_aqi: a.current.european_aqi
  } : null;

  return { weather, air, fetchedAt: Date.now() };
}

function updateWxUI(wx) {
  if (wx?.weather) {
    const w = wx.weather;
    wxEl.textContent =
      `${fmt(w.temperature_2m,1)}°C · RH ${fmt(w.relative_humidity_2m,0)}% · ` +
      `Wind ${fmt(w.wind_speed_10m,1)} m/s`;
  } else {
    wxEl.textContent = '—';
  }
  if (wx?.air) {
    const a = wx.air;
    airEl.textContent =
      `PM2.5 ${fmt(a.pm2_5,1)} µg/m³ · PM10 ${fmt(a.pm10,1)} · ` +
      `O₃ ${fmt(a.ozone,1)} µg/m³ · EU-AQI ${fmt(a.european_aqi,0)}`;
  } else {
    airEl.textContent = '—';
  }
}

//Periodic weather refresh
async function refreshWeatherIfDue() {
  if (!lastPos) return;
  const now = Date.now();
  if (now - wxCache.fetchedAt < WEATHER_PERIOD_MS) return; 

  progressEl.textContent = 'Refreshing weather & air-quality…';
  try {
    wxCache = await fetchOpenMeteo(lastPos.lat, lastPos.lon);
    updateWxUI(wxCache);
    progressEl.textContent = `Weather updated @ ${new Date(wxCache.fetchedAt).toLocaleTimeString()}`;
  } catch (e) {
    console.error(e);
    progressEl.textContent = `Weather update failed: ${e.message}`;
  }
}

//Per-second flush
async function flushOneSecond() {
  //need at least one valid mic sample + a GPS fix + a weather snapshot
  if (!countDB || !lastPos || !wxCache.weather || !wxCache.air || !currentUID || !sessionDocRef) return;

  const avgDB = sumDB / countDB;
  const when  = new Date();

  //reset bucket
  bucketStart = 0; sumDB = 0; countDB = 0;

  try {
    await addDoc(readingsColRef, clean({
      ts: Timestamp.fromDate(when),
      lat: lastPos.lat,
      lon: lastPos.lon,
      accuracy_m: Number(lastPos.acc),
      sound_dbfs: avgDB,
      weather: wxCache.weather,
      air: wxCache.air
    }));
    session.totalReadings += 1;
    progressEl.textContent = `Saved ${session.totalReadings} reading(s)…`;
  } catch (e) {
    console.error(e);
    progressEl.textContent = `Write failed: ${e.message}`;
  }
}

//Start / Stop
async function start() {
  if (!currentUID) { progressEl.textContent = 'Signing in… try again in a moment.'; return; }
  if (!('geolocation' in navigator)) { progressEl.textContent = 'Geolocation not available.'; return; }

  //Fresh session
  session = { id: null, startedAt: new Date(), endedAt: null, totalReadings: 0 };

  //Create session doc first
  const sessionsCol = collection(db, 'users', currentUID, 'sessions');
  sessionDocRef = doc(sessionsCol);
  readingsColRef = collection(sessionDocRef, 'readings');

  await setDoc(sessionDocRef, clean({
    startedAt: Timestamp.fromDate(session.startedAt),
    samplePeriodMs: FLUSH_PERIOD_MS,
    weatherPeriodMs: WEATHER_PERIOD_MS,
    device: {
      userAgent: navigator.userAgent || '',
      platform: navigator.platform || ''
    },
    createdAt: serverTimestamp()
  }));
  session.id = sessionDocRef.id;

  try {
    //Get an initial precise position
    progressEl.textContent = 'Getting GPS fix…';
    const first = await getCurrentPositionOnce();
    const { latitude: lat, longitude: lon, accuracy: acc } = first.coords;
    lastPos = { lat, lon, acc };
    locEl.textContent = `Location: ${fmt(lat,6)}, ${fmt(lon,6)} (±${fmt(acc,1)}m)`;

    //Fetch weather + air quality BEFORE starting logging
    progressEl.textContent = 'Fetching weather & air-quality…';
    wxCache = await fetchOpenMeteo(lat, lon);
    updateWxUI(wxCache);

    //Start continuous GPS watch
    startGPS();

    //Start mic
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    ana = ctx.createAnalyser(); ana.fftSize = 2048;
    src = ctx.createMediaStreamSource(stream); src.connect(ana);
    micStartAt = performance.now();
    bucketStart = 0; sumDB = 0; countDB = 0;

    //Start loops
    logging = true;
    sampleMic();
    flushTimer   = setInterval(flushOneSecond, FLUSH_PERIOD_MS);
    weatherTimer = setInterval(refreshWeatherIfDue, 2000); // cheap poll every 2s; fetch happens each minute

    statusEl.classList.remove('stopped'); statusEl.classList.add('running');
    statusEl.textContent = 'Running…';
    startBtn.disabled = true; stopBtn.disabled = false;
    progressEl.textContent = `Session ${session.id} started`;
  } catch (e) {
    statusEl.classList.remove('running'); statusEl.classList.add('stopped');
    statusEl.textContent = 'Stopped';
    progressEl.textContent = 'Error: ' + e.message;
    console.error(e);
  }
}

async function stop() {
  logging = false;

  if (raf) cancelAnimationFrame(raf);
  if (flushTimer)   { clearInterval(flushTimer); flushTimer = null; }
  if (weatherTimer) { clearInterval(weatherTimer); weatherTimer = null; }
  stopGPS();

  try { src && src.disconnect(); } catch {}
  try { ctx && ctx.close(); } catch {}
  try { stream && stream.getTracks().forEach(t => t.stop()); } catch {}

  statusEl.classList.remove('running'); statusEl.classList.add('stopped');
  statusEl.querySelector('#statusText')?.textContent = 'Stopped';
  startBtn.disabled = false; stopBtn.disabled = true;

  //Final flush if bucket has data and weather present
  await flushOneSecond();

  //Update session
  session.endedAt = new Date();
  try {
    await updateDoc(sessionDocRef, clean({
      endedAt: Timestamp.fromDate(session.endedAt),
      totalReadings: session.totalReadings,
      updatedAt: serverTimestamp()
    }));
    progressEl.textContent = `Session ${session.id} saved (${session.totalReadings} readings).`;
  } catch (e) {
    console.error(e);
    progressEl.textContent = `Session update failed: ${e.message}`;
  }

  //Reset working vars
  lastPos = null;
  wxCache = { fetchedAt: 0, weather: null, air: null };
  bucketStart = 0; sumDB = 0; countDB = 0;
}

//Wire buttons
startBtn.addEventListener('click', start, { passive:true });
stopBtn.addEventListener('click', stop, { passive:true });