import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
  getFirestore, doc, setDoc, collection, writeBatch, addDoc,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

//Firebase config

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
const db   = getFirestore(app);

//DOM
const $ = id => document.getElementById(id);
const statusEl = $('status'), micEl = $('micDisplay'), locEl = $('locationDisplay');
const startBtn = $('start'), stopBtn = $('stop');
const progressEl = $('progress');

//Sensor & session state
let stream, ctx, ana, src, raf;
let gpsTimer = null, flushTimer = null, logging = false, lastDB = NaN;
const micBuf = new Float32Array(2048);

const GPS_PERIOD_MS   = 1000;
const FLUSH_PERIOD_MS = 1000;
const pending = [];

let currentUID = null;
let session = { id: null, startedAt: null, endedAt: null };
let sessionDocRef = null;
let readingsColRef = null;

//helpers
const fmt  = (n, d) => Number.isFinite(n) ? Number(n).toFixed(d) : '';
const dbfs = rms => 20 * Math.log10(Math.max(rms, 1e-12));

//mic sampler
function sampleDB() {
  if (!ana) return;
  ana.getFloatTimeDomainData(micBuf);
  let s = 0; for (let i = 0; i < micBuf.length; i++) s += micBuf[i] * micBuf[i];
  lastDB = dbfs(Math.sqrt(s / micBuf.length));
  micEl.textContent = `Mic: ${lastDB.toFixed(1)} dBFS`;
  if (logging) raf = requestAnimationFrame(sampleDB);
}

//gps sampler
function capturePosition() {
  const opts = { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 };
  navigator.geolocation.getCurrentPosition(onPos, onGeoErr, opts);
}
function onPos(p) {
  const { latitude: lat, longitude: lon, accuracy: acc } = p.coords;
  locEl.textContent = `Location: ${fmt(lat,6)}, ${fmt(lon,6)} (±${fmt(acc,1)}m)`;
  pending.push({
    ts: new Date(),
    lat, lon, acc,
    db: Number.isFinite(lastDB) ? Number(lastDB.toFixed(2)) : null
  });
}
function onGeoErr(e) {
  locEl.textContent = `Location: Error - ${e.message}`;
}

//realtime uploader (flush pending → Firestore every 1s)
async function flushPending() {
  if (!pending.length || !readingsColRef) return;

  const batch = writeBatch(db);
  const items = pending.splice(0, pending.length);
  for (const r of items) {
    const rd = doc(readingsColRef);
    batch.set(rd, {
      ts: Timestamp.fromDate(r.ts),
      lat: r.lat,
      lon: r.lon,
      accuracy_m: r.acc,
      sound_dbfs: r.db
    });
  }
  await batch.commit();
  progressEl.textContent = `Uploaded ${items.length} reading(s)`;
}

//auth
signInAnonymously(auth).catch(console.error);
onAuthStateChanged(auth, user => { currentUID = user ? user.uid : null; });

//start/stop
async function start() {
  if (!currentUID) {
    progressEl.textContent = "Waiting for sign-in…";

    await new Promise(r => {
      let t = setInterval(() => { if (currentUID) { clearInterval(t); r(); } }, 100);
    });
  }

  pending.length = 0;
  session.startedAt = new Date();
  session.endedAt = null;

  try {
    //creating session doc
    const sessionsCol = collection(db, 'users', currentUID, 'sessions');
    sessionDocRef = doc(sessionsCol);
    readingsColRef = collection(sessionDocRef, 'readings');

    await setDoc(sessionDocRef, {
      startedAt: Timestamp.fromDate(session.startedAt),
      samplePeriodMs: GPS_PERIOD_MS,
      device: { userAgent: navigator.userAgent || '', platform: navigator.platform || '' },
      createdAt: serverTimestamp()
    });

    //mic
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    ana = ctx.createAnalyser(); ana.fftSize = 2048;
    src = ctx.createMediaStreamSource(stream); src.connect(ana);

    //gps
    if (!('geolocation' in navigator)) throw new Error('Geolocation not available');

    //immediate reading + intervals
    capturePosition();
    gpsTimer = setInterval(capturePosition, GPS_PERIOD_MS);
    flushTimer = setInterval(flushPending, FLUSH_PERIOD_MS);

    logging = true; sampleDB();
    statusEl.textContent = 'Running…';
    startBtn.disabled = true; stopBtn.disabled = false;
    progressEl.textContent = `Session ${sessionDocRef.id} started`;
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
    console.error(e);
  }
}

async function stop() {
  logging = false;
  session.endedAt = new Date();

  if (raf) cancelAnimationFrame(raf);
  if (gpsTimer)   { clearInterval(gpsTimer); gpsTimer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }

  try { src && src.disconnect(); } catch {}
  try { ctx && ctx.close(); } catch {}
  try { stream && stream.getTracks().forEach(t => t.stop()); } catch {}

  //final flush + update session summary
  try {
    await flushPending();
    await setDoc(sessionDocRef, {
      endedAt: Timestamp.fromDate(session.endedAt),
      totalReadings: (await import("https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js"))
        .getCountFromServer ? undefined : undefined
    }, { merge: true });
    progressEl.textContent = `Session ${sessionDocRef.id} ended`;
  } catch (e) {
    progressEl.textContent = 'Upload failed: ' + e.message;
    console.error(e);
  }

  statusEl.textContent = 'Stopped';
  startBtn.disabled = false; stopBtn.disabled = true;
}

//buttons listener
startBtn.addEventListener('click', start, { passive:true });
stopBtn.addEventListener('click', stop, { passive:true });