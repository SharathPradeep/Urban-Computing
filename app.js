// ====== Firebase (modular SDK via CDN) ======
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
  getFirestore, doc, setDoc, collection, addDoc,
  serverTimestamp, Timestamp, updateDoc
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

// === 1) PASTE YOUR FIREBASE CONFIG HERE ===
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  appId: "YOUR_APP_ID",
};
// ===========================================

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Keep the anonymous UID across tab closes (until cookies/site data are cleared)
await setPersistence(auth, browserLocalPersistence).catch(console.error);
const db   = getFirestore(app);

// ====== DOM ======
const $ = id => document.getElementById(id);
const statusEl = $('status'), micEl = $('micDisplay'), locEl = $('locationDisplay');
const startBtn = $('start'), stopBtn = $('stop');
const progressEl = $('progress');

// ====== Helpers ======
// 1) remove undefined, null, NaN, and "" (recursively)
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
      if (
        !(vv === undefined || vv === null ||
          (typeof vv === 'number' && !Number.isFinite(vv)) ||
          vv === '')
      ) o[k] = vv;
    }
    return o;
  }
  return obj;
}

const fmt  = (n, d) => Number.isFinite(n) ? Number(n).toFixed(d) : '';
const dbfs = rms => 20 * Math.log10(Math.max(rms, 1e-12));

// ====== Sensor & session state ======
let stream, ctx, ana, src, raf;
let gpsWatchId = null, logging = false;

const micBuf = new Float32Array(2048);

// mic averaging bucket (1s)
let bucketStart = 0;
let sumDB = 0;
let countDB = 0;

// latest GPS fix
let lastPos = null;

// timers
const FLUSH_PERIOD_MS = 1000;
let flushTimer = null;

// session
let currentUID = null;
let session = { id: null, startedAt: null, endedAt: null, totalReadings: 0 };
let sessionDocRef = null;
let readingsColRef = null;

// ====== Auth ======
signInAnonymously(auth).catch(console.error);
onAuthStateChanged(auth, user => { currentUID = user ? user.uid : null; });

// ====== Mic sampler (animation frame) ======
function sampleMic() {
  if (!ana) return;
  ana.getFloatTimeDomainData(micBuf);
  let s = 0;
  for (let i = 0; i < micBuf.length; i++) s += micBuf[i] * micBuf[i];
  const rms = Math.sqrt(s / micBuf.length);
  const vdb = dbfs(rms);
  micEl.textContent = `Mic: ${vdb.toFixed(1)} dBFS`;

  // accumulate into 1-second bucket
  if (!bucketStart) bucketStart = performance.now();
  sumDB += vdb; countDB += 1;

  if (logging) raf = requestAnimationFrame(sampleMic);
}

// ====== GPS via watchPosition ======
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

// ====== 1-second flush to Firestore ======
async function flushOneSecond() {
  // we need both a mic avg and a GPS fix
  if (!countDB || !lastPos || !currentUID || !sessionDocRef) return;

  const avgDB = sumDB / countDB;
  const when  = new Date(); // end of bucket

  // reset bucket
  bucketStart = 0; sumDB = 0; countDB = 0;

  try {
    await addDoc(readingsColRef, clean({
      ts: Timestamp.fromDate(when),
      lat: lastPos.lat,
      lon: lastPos.lon,
      accuracy_m: Number(lastPos.acc),
      sound_dbfs: Number(avgDB.toFixed(2))
    }));
    session.totalReadings += 1;
    progressEl.textContent = `Saved ${session.totalReadings} reading(s)…`;
  } catch (e) {
    console.error(e);
    progressEl.textContent = `Write failed: ${e.message}`;
  }
}

// ====== Start / Stop ======
async function start() {
  if (!currentUID) { progressEl.textContent = 'Signing in… try again in a moment.'; return; }

  // fresh session
  session = { id: null, startedAt: new Date(), endedAt: null, totalReadings: 0 };

  // create session doc first
  const sessionsCol = collection(db, 'users', currentUID, 'sessions');
  sessionDocRef = doc(sessionsCol); // auto-id
  readingsColRef = collection(sessionDocRef, 'readings');

  await setDoc(sessionDocRef, clean({
    startedAt: Timestamp.fromDate(session.startedAt),
    samplePeriodMs: FLUSH_PERIOD_MS,
    device: {
      userAgent: navigator.userAgent || '',
      platform: navigator.platform || ''
    },
    createdAt: serverTimestamp()
  }));

  session.id = sessionDocRef.id;

  try {
    // mic
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    ana = ctx.createAnalyser(); ana.fftSize = 2048;
    src = ctx.createMediaStreamSource(stream); src.connect(ana);

    // gps
    if (!('geolocation' in navigator)) throw new Error('Geolocation not available');
    startGPS();

    // loops
    logging = true;
    sampleMic();
    flushTimer = setInterval(flushOneSecond, FLUSH_PERIOD_MS);

    statusEl.textContent = 'Running…';
    startBtn.disabled = true; stopBtn.disabled = false;
    progressEl.textContent = `Session ${session.id} started`;
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
    console.error(e);
  }
}

async function stop() {
  logging = false;

  if (raf) cancelAnimationFrame(raf);
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  stopGPS();

  try { src && src.disconnect(); } catch {}
  try { ctx && ctx.close(); } catch {}
  try { stream && stream.getTracks().forEach(t => t.stop()); } catch {}

  statusEl.textContent = 'Stopped';
  startBtn.disabled = false; stopBtn.disabled = true;

  // final flush in case there's a partial bucket with GPS
  await flushOneSecond();

  // update session safely (strip undefineds)
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

  // clear working vars
  lastPos = null;
  bucketStart = 0; sumDB = 0; countDB = 0;
}
startBtn.addEventListener('click', start, { passive:true });
stopBtn.addEventListener('click', stop, { passive:true });
