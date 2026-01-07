// GMAT Vocab Trainer — PWA (offline)
// Features:
// - Due deck + Focus deck (wrong >= 2)
// - Mixed direction EN↔VI / EN→VI / VI→EN
// - Typing / MCQ / Flashcards (tap + swipe) / Mini Test
// - Export/Import progress JSON
// - Keyboard shortcuts (Enter submit, A/B/C/D, Space next)

const STORAGE_KEY = "gmat_vocab_progress_v3";
const SETTINGS_KEY = "gmat_vocab_settings_v3";
const DAILY_KEY = "gmat_vocab_daily_v3";

let vocab = [];        // [{en, vi}]
let progress = {};     // { [en]: {box, streak, correct, wrong, lastSeen, nextDue} }
let settings = {
  dailyGoal: 30,
  deck: "due",
  mode: "typing",
  direction: "mixed",
  theme: "system" // "system" | "light" | "dark"
};

let currentLang = "en_vi";

const VOCAB_FILES = {
  en_vi: "data/gmat_en_vi.csv",
  en_ko: "data/gmat_en_ko.csv",
  en_zh: "data/gmat_en_zh.csv",
}; 

let order = [];         // indices for normal study
let currentIdx = null;  // index in vocab

// per-card prompt state
let currentDirection = "en_vi";   // actual direction used for this card
let currentPromptText = "";       // what we display on card
let currentCorrectText = "";      // expected answer (string)
let currentMCQCorrect = "";

// Flashcards state
let flashFlipped = false;
let touchStartX = null;

// Mini Test state
let testActive = false;
let testTotal = 15;
let testQueue = [];        // indices to test
let testAnswered = 0;
let testCorrect = 0;
let testMissed = [];       // [{prompt, correct}]

// ---------- utils ----------
function nowTs() { return Date.now(); }
function todayKey() { return new Date().toISOString().slice(0, 10); }

function leitnerDays(box) {
  return ({1:0, 2:1, 3:3, 4:7, 5:14}[box] ?? 0);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function stripVN(s) {
  return (s || "")
    .trim().toLowerCase().replace(/\s+/g, " ")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

function safeJSONParse(v, fallback) {
  try { return JSON.parse(v) ?? fallback; } catch { return fallback; }
}

function getSystemTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark" : "light";
}

function applyTheme() {
  const theme = (settings.theme === "system") ? getSystemTheme() : settings.theme;
  document.body.setAttribute("data-theme", theme);

  const btn = document.getElementById("btnTheme");
  if (btn) {
    if (theme === "dark") btn.textContent = "☀️ Light";
    else btn.textContent = "🌙 Dark";
  }
}

function toggleTheme() {
  // Toggle between light and dark (keep it simple)
  const current = (settings.theme === "system") ? getSystemTheme() : settings.theme;
  settings.theme = (current === "dark") ? "light" : "dark";
  saveSettings();
  applyTheme();
}

window.toggleTheme = toggleTheme;

// Robust CSV split: supports quotes
function splitCSVLine(line) {
  let inQuotes = false;
  const out = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.replace(/^"|"$/g, "").trim());
}

function makeIdFromEnglish(en) {
  const s = (en || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s ? `w_${s}` : `w_${Math.random().toString(36).slice(2, 10)}`;
}



// ---------- storage ----------
function loadSettings() {
  const s = safeJSONParse(localStorage.getItem(SETTINGS_KEY), null);
  if (s && typeof s === "object") settings = { ...settings, ...s };
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadProgress() {
  const p = safeJSONParse(localStorage.getItem(STORAGE_KEY), null);
  if (p && typeof p === "object") progress = p;
}
function saveProgress() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
}

function getDailyStats() {
  const stats = safeJSONParse(localStorage.getItem(DAILY_KEY), {});
  const day = todayKey();
  if (!stats[day]) stats[day] = { attempts: 0, correct: 0 };
  return { stats, day };
}
function bumpDaily(isCorrect) {
  const { stats, day } = getDailyStats();
  stats[day].attempts += 1;
  if (isCorrect) stats[day].correct += 1;
  localStorage.setItem(DAILY_KEY, JSON.stringify(stats));
}

//updateChips
function updateChips() {
  const chipBox = document.getElementById("chipBox");
  const chipStreak = document.getElementById("chipStreak");
  const chipDue = document.getElementById("chipDue");
  const chipFocus = document.getElementById("chipFocus");

  if (chipDue) chipDue.textContent = `Due: ${getDueCount()}`;
  if (chipFocus) chipFocus.textContent = `Focus: ${getFocusCount()}`;

  const card = vocab?.[currentIdx];
  const id = card?.id;

  if (!id) {
    if (chipBox) chipBox.textContent = "Box: -";
    if (chipStreak) chipStreak.textContent = "Streak: -";
    return;
  }

  ensureCard(id);
  const st = progress[id] || {};
  const box = st.box ?? 1;
  const streak = st.streak ?? 0;

  if (chipBox) chipBox.textContent = `Box: ${box}`;
  if (chipStreak) chipStreak.textContent = `Streak: ${streak}`;

  // optional: màu theo box (nếu CSS có .box1..box5)
  if (chipBox) {
    chipBox.classList.remove("box1", "box2", "box3", "box4", "box5");
    chipBox.classList.add(`box${Math.min(5, Math.max(1, box))}`);
  }
}



// ---------- progress ----------
function ensureCard(id) {
  if (!progress[id]) {
    progress[id] = { box: 1, streak: 0, correct: 0, wrong: 0, lastSeen: 0, nextDue: 0 };
  }
}

function isDue(id) {
  ensureCard(id);
  return (progress[id].nextDue ?? 0) <= nowTs();
}

function focusEligible(id) {
  ensureCard(id);
  return (progress[id].wrong ?? 0) >= 2;
}

function getFocusCount() {
  return vocab.reduce((acc, v) => acc + (focusEligible(v.id) ? 1 : 0), 0);
}

function getDueCount() {
  return vocab.reduce((acc, v) => acc + (isDue(v.id) ? 1 : 0), 0);
}

// ---------- deck building ----------
function buildDeckIndices() {
  const indices = [];

  if (settings.deck === "focus") {
    for (let i = 0; i < vocab.length; i++) {
      if (focusEligible(vocab[i].id)) indices.push(i);
    }
    if (indices.length === 0) {
      // fallback to due if focus empty
      settings.deck = "due";
      saveSettings();
      return buildDeckIndices();
    }
    return shuffle(indices);
  }

  // due deck
  for (let i = 0; i < vocab.length; i++) {
    if (isDue(vocab[i].id)) indices.push(i);
  }
  if (indices.length > 0) return shuffle(indices);

  // nothing due -> pick lowest box slice
  const sorted = [...Array(vocab.length).keys()].sort((a, b) => {
    const ea = vocab[a].en, eb = vocab[b].en;
    return (progress[ea].box - progress[eb].box) || ((progress[ea].nextDue ?? 0) - (progress[eb].nextDue ?? 0));
  });
  return shuffle(sorted.slice(0, Math.min(30, sorted.length)));
}

let toastTimer = null;

function showToast(message, type = "ok", ms = 900) {
  const el = document.getElementById("toast");
  if (!el) return;

  el.classList.remove("ok", "bad", "show");
  el.textContent = message;
  el.classList.add(type === "bad" ? "bad" : "ok");

  // force reflow to replay animation
  void el.offsetWidth;
  el.classList.add("show");

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
  }, ms);
}

// ---------- UI helpers ----------
function setModeUI() {
  document.getElementById("btnTyping")?.classList.toggle("active", settings.mode === "typing");
  document.getElementById("btnMCQ")?.classList.toggle("active", settings.mode === "mcq");
  document.getElementById("btnFlash")?.classList.toggle("active", settings.mode === "flash");
  document.getElementById("btnTest")?.classList.toggle("active", settings.mode === "test");

  document.getElementById("typingArea").style.display = (settings.mode === "typing") ? "block" : "none";
  document.getElementById("mcqArea").style.display = (settings.mode === "mcq") ? "block" : "none";
  document.getElementById("flashArea").style.display = (settings.mode === "flash") ? "block" : "none";
  document.getElementById("testArea").style.display = (settings.mode === "test") ? "block" : "none";
}

function setDeckUI() {
  document.getElementById("btnDue")?.classList.toggle("active", settings.deck === "due");
  document.getElementById("btnFocus")?.classList.toggle("active", settings.deck === "focus");
}

function setDirectionUI() {
  document.getElementById("btnDirMixed")?.classList.toggle("active", settings.direction === "mixed");
  document.getElementById("btnDirENVI")?.classList.toggle("active", settings.direction === "en_vi");
  document.getElementById("btnDirVIEN")?.classList.toggle("active", settings.direction === "vi_en");
}

function updateTopBar() {
  const { stats, day } = getDailyStats();
  const attempts = stats[day].attempts;
  const goal = settings.dailyGoal;

  document.getElementById("todayText").innerText = `Today: ${attempts}/${goal}`;
  const pct = goal > 0 ? Math.min(100, Math.round((attempts / goal) * 100)) : 0;
  document.getElementById("todayBar").style.width = pct + "%";

  document.getElementById("dueText").innerText = `Due: ${getDueCount()}`;
  const focusEl = document.getElementById("focusInfo");
  if (focusEl) focusEl.innerText = `Focus: ${getFocusCount()}`;
  updateChips();
}

function pickDirectionForCard() {
  if (settings.direction === "en_vi") return "en_vi";
  if (settings.direction === "vi_en") return "vi_en";
  return Math.random() < 0.5 ? "en_vi" : "vi_en";
}

function setPromptState() {
  if (currentIdx === null) return;

  const card = vocab[currentIdx];
  ensureCard(card.id);
  const st = progress[card.id];

  currentDirection = pickDirectionForCard();

  if (currentDirection === "en_vi") {
    currentPromptText = card.en;
    currentCorrectText = card.vi;
  } else {
    currentPromptText = card.vi;
    currentCorrectText = card.en;
  }

  // prompt labels
  const promptEl = document.getElementById("prompt");
  const wordEl = document.getElementById("word");
  const fb = document.getElementById("feedback");
  fb.innerText = "";

  promptEl.innerText = `Box ${st.box} • Translate: ${currentDirection === "en_vi" ? "EN → VI" : "VI → EN"}`;
  wordEl.innerText = currentPromptText;

  if (settings.mode === "typing") {
    const input = document.getElementById("answer");
    input.value = "";
    input.placeholder = currentDirection === "en_vi" ? "Type Vietnamese meaning..." : "Type English word/phrase...";
    input.focus();
  } else if (settings.mode === "mcq") {
    renderMCQ();
  } else if (settings.mode === "flash") {
    flashFlipped = false;
    wordEl.innerText = currentPromptText;
  } else if (settings.mode === "test") {
    // test uses user's choice: keep typing default, allow MCQ switch
    // We'll display according to whichever area currently visible:
    // If user is in test mode, typingArea stays hidden, so we still render MCQ/Typing via same UI blocks
    // We'll default to typing input (inside typingArea) if user switches to typing (not recommended in test UI).
    // For simplicity, render MCQ by default in test if mcqArea is visible.
    if (document.getElementById("mcqArea").style.display === "block") renderMCQ();
    else {
      const input = document.getElementById("answer");
      if (input) {
        input.value = "";
        input.placeholder = currentDirection === "en_vi" ? "Type Vietnamese meaning..." : "Type English word/phrase...";
      }
    }
  }
  updateChips();
}

function nextCard() {
  if (!Array.isArray(vocab) || vocab.length === 0) {
    document.getElementById("prompt").innerText = "No vocab loaded.";
    document.getElementById("word").innerText = "Check vocab.csv and reload.";
    document.getElementById("feedback").innerText = "";
    return;
  }

  if (!Array.isArray(order) || order.length === 0) {
    order = buildDeckIndices();
    if (order.length === 0) order = shuffle([...Array(vocab.length).keys()]);
  }

  currentIdx = order.pop();
  if (currentIdx === undefined || currentIdx === null) return;

  setPromptState();
  updateTopBar();
}

// ---------- grading + SRS ----------
function answersMatch(userText, correctText) {
  const u = stripVN(userText);
  const c = stripVN(correctText);
  if (!u || !c) return false;
  return c.includes(u) || u.includes(c);
}

function applySRS(isCorrect) {
  const card = vocab[currentIdx];
  const st = progress[card.id];

  st.lastSeen = nowTs();

  if (isCorrect) {
    st.correct += 1;
    st.streak += 1;
    st.box = Math.min(5, st.box + 1);
  } else {
    st.wrong += 1;
    st.streak = 0;
    st.box = 1;
  }

  const days = leitnerDays(st.box);
  st.nextDue = st.lastSeen + days * 24 * 3600 * 1000;

  progress[card.id] = st;
  saveProgress();
  bumpDaily(isCorrect);
  updateTopBar();
}

// ---------- Mini Test ----------
function updateTestStatus() {
  const el = document.getElementById("testStatus");
  if (!el) return;
  if (!testActive) el.innerText = "Test: not started";
  else el.innerText = `Test: ${testAnswered}/${testTotal} • Correct: ${testCorrect}`;
}

function showTestSummary() {
  const pct = Math.round((testCorrect / Math.max(1, testTotal)) * 100);
  let text = `✅ Test finished!\nScore: ${testCorrect}/${testTotal} (${pct}%)`;

  if (testMissed.length > 0) {
    text += `\n\n❌ Missed (${testMissed.length}) — pushed to Focus:\n`;
    testMissed.slice(0, 12).forEach((m, i) => {
      text += `${i+1}. ${m.prompt} → ${m.correct}\n`;
    });
    if (testMissed.length > 12) text += `...and ${testMissed.length - 12} more\n`;
  } else {
    text += `\n\n🔥 Perfect run.`;
  }

  const box = document.getElementById("testSummary");
  if (box) {
    box.innerText = text;
    box.style.display = "block";
  }
}

function endTest() {
  if (!testActive) return;
  testActive = false;
  updateTestStatus();
  showTestSummary();
  updateTopBar();
}

function markTestAnswer(isCorrect) {
  if (!testActive || currentIdx === null) return;

  const card = vocab[currentIdx];
  const promptShown = currentPromptText;
  const correct = currentCorrectText;

  testAnswered += 1;
  if (isCorrect) testCorrect += 1;
  else {
    testMissed.push({ prompt: promptShown, correct });
    // push to focus immediately
    ensureCard(card.id);
    progress[card.id].wrong = Math.max(progress[card.id].wrong ?? 0, 2);
    saveProgress();
  }

  updateTestStatus();

  if (testAnswered >= testTotal || testQueue.length === 0) {
    endTest();
  } else {
    setTimeout(() => nextTestCard(), isCorrect ? 500 : 700);
  }
}

function nextTestCard() {
  if (!testActive) return;
  if (testQueue.length === 0) { endTest(); return; }
  currentIdx = testQueue.shift();
  setPromptState();
  updateTestStatus();
}

function startTest() {
  const v = parseInt(document.getElementById("testSize")?.value, 10);
  testTotal = Number.isFinite(v) ? Math.min(50, Math.max(5, v)) : 15;

  // Build queue from due deck first; if not enough, sample all
  const base = buildDeckIndices();
  let pool = base.length > 0 ? base : shuffle([...Array(vocab.length).keys()]);
  testQueue = pool.slice(0, testTotal);

  testActive = true;
  testAnswered = 0;
  testCorrect = 0;
  testMissed = [];

  const summary = document.getElementById("testSummary");
  if (summary) summary.style.display = "none";

  updateTestStatus();
  nextTestCard();
}

// ---------- Typing ----------
function submitAnswer() {
  if (currentIdx === null) return;
  const user = document.getElementById("answer")?.value ?? "";
  const ok = answersMatch(user, currentCorrectText);

  applySRS(ok);

  showToast(ok ? "✅ Correct" : `❌ ${currentCorrectText}`, ok ? "ok" : "bad", ok ? 750 : 1300);

// (optional) vẫn giữ feedback dưới card nếu muốn:
  const fb = document.getElementById("feedback");
  if (fb) fb.innerText = "";  // <= để trống cho gọn

  if (testActive) {
    markTestAnswer(ok);
    return;
  }

  if (ok) setTimeout(() => nextCard(), 1200);
}

// ---------- MCQ ----------
function pickWrongChoices(correctChoiceText) {
  const pool = vocab.map(v => (currentDirection === "en_vi") ? v.vi : v.en)
    .filter(x => x && stripVN(x) !== stripVN(correctChoiceText));

  const chosen = new Set();
  while (chosen.size < 3 && pool.length > 0) {
    chosen.add(pool[Math.floor(Math.random() * pool.length)]);
  }
  return [...chosen];
}

function renderMCQ() {
  if (currentIdx === null) return;

  currentMCQCorrect = currentCorrectText;
  const wrongs = pickWrongChoices(currentMCQCorrect);
  const choices = shuffle([currentMCQCorrect, ...wrongs].slice(0, 4));
  while (choices.length < 4) choices.push(currentMCQCorrect);

  const box = document.getElementById("mcqChoices");
  box.innerHTML = "";

  const labels = ["A", "B", "C", "D"];
  choices.forEach((text, i) => {
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.textContent = `${labels[i]}. ${text}`;
    btn.onclick = () => answerMCQ(text, box);
    box.appendChild(btn);
  });
}

function answerMCQ(chosenText, container) {
  const ok = stripVN(chosenText) === stripVN(currentMCQCorrect);

  applySRS(ok);

  [...container.querySelectorAll("button")].forEach(b => b.disabled = true);

  showToast(ok ? "✅ Correct" : `❌ ${currentMCQCorrect}`, ok ? "ok" : "bad", ok ? 750 : 1300);

  const fb = document.getElementById("feedback");
  if (fb) fb.innerText = "";


  if (testActive) {
    markTestAnswer(ok);
    return;
  }

  if (ok) setTimeout(() => nextCard(), 900);
}

// ---------- Flashcards ----------
function toggleFlashFlip() {
  if (currentIdx === null) return;
  flashFlipped = !flashFlipped;
  document.getElementById("word").innerText = flashFlipped ? currentCorrectText : currentPromptText;
}

function flashGotIt() {
  if (currentIdx === null) return;
  applySRS(true);
  showToast("✅ Got it", "ok", 650);
const fb = document.getElementById("feedback");
if (fb) fb.innerText = "";
  setTimeout(() => nextCard(), 500);
}

function flashMissed() {
  if (currentIdx === null) return;
  const idKey = vocab[currentIdx].id;
  ensureCard(idKey);
  applySRS(false);
  // push into focus immediately
  progress[idKey].wrong = Math.max(progress[idKey].wrong ?? 0, 2);
  saveProgress();
  showToast(`❌ ${currentCorrectText}`, "bad", 6000);
const fb = document.getElementById("feedback");
if (fb) fb.innerText = "";
}

// ---------- Export / Import ----------
function exportProgress() {
  const payload = {
    version: 3,
    exportedAt: new Date().toISOString(),
    settings,
    progress,
    daily: safeJSONParse(localStorage.getItem(DAILY_KEY), {})
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gmat_vocab_progress_${todayKey()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}


function triggerImport() {
  const input = document.getElementById("importFile");
  input.value = "";
  input.click();
}

function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const data = safeJSONParse(reader.result, null);
    if (!data || typeof data !== "object") {
      alert("File import failed: invalid JSON");
      return;
    }

    if (data.progress && typeof data.progress === "object") {
      progress = { ...progress, ...data.progress };

      // migrate possible old-format keys (english) -> ids
      const enToId = {};
      for (const item of vocab) enToId[item.en] = item.id;
      for (const k of Object.keys(progress)) {
        if (enToId[k] && !progress[enToId[k]]) {
          progress[enToId[k]] = progress[k];
          delete progress[k];
        }
      }

      for (const item of vocab) ensureCard(item.id);
      saveProgress();
    }

    if (data.settings && typeof data.settings === "object") {
      settings = { ...settings, ...data.settings };
      saveSettings();
    }

    if (data.daily && typeof data.daily === "object") {
      localStorage.setItem(DAILY_KEY, JSON.stringify(data.daily));
    }

    document.getElementById("goalInput").value = String(settings.dailyGoal);
    setModeUI(); setDeckUI(); setDirectionUI();
    order = buildDeckIndices();
    nextCard();
    alert("Import successful ✅");
  };
  reader.readAsText(file);
}

// ---------- settings actions ----------
function setGoal() {
  const v = parseInt(document.getElementById("goalInput").value, 10);
  settings.dailyGoal = Number.isFinite(v) && v > 0 ? v : 30;
  saveSettings();
  updateTopBar();
}

function setMode(m) {
  settings.mode = m;
  saveSettings();
  setModeUI();

  // leaving test mode stops test
  if (m !== "test" && testActive) {
    testActive = false;
    updateTestStatus();
    const summary = document.getElementById("testSummary");
    if (summary) summary.style.display = "none";
  }

  setPromptState();
}

function setDeck(d) {
  settings.deck = d;
  saveSettings();
  setDeckUI();
  order = buildDeckIndices();
  nextCard();
}

function setDirection(dir) {
  settings.direction = dir;
  saveSettings();
  setDirectionUI();
  setPromptState();
}

// expose
window.submitAnswer = submitAnswer;
window.nextCard = nextCard;
window.setGoal = setGoal;
window.setMode = setMode;
window.setDeck = setDeck;
window.setDirection = setDirection;
window.exportProgress = exportProgress;
window.triggerImport = triggerImport;

window.flashGotIt = flashGotIt;
window.flashMissed = flashMissed;

window.startTest = startTest;
window.endTest = endTest;

// ---------- Keyboard shortcuts ----------
document.addEventListener("keydown", (e) => {
  const isInput = document.activeElement?.tagName === "INPUT";

  if (e.key === "Enter" && settings.mode === "typing") {
    e.preventDefault();
    submitAnswer();
    return;
  }

  if (e.code === "Space" && !isInput) {
    e.preventDefault();
    if (testActive) nextTestCard();
    else nextCard();
    return;
  }

  if (settings.mode === "mcq") {
    const key = e.key.toUpperCase();
    const map = { A: 0, B: 1, C: 2, D: 3 };
    if (key in map) {
      e.preventDefault();
      const idx = map[key];
      const buttons = document.querySelectorAll("#mcqChoices button");
      if (buttons[idx] && !buttons[idx].disabled) buttons[idx].click();
    }
  }
});

// ---------- init ----------
async function loadVocabCSV() {
  const res = await fetch(VOCAB_FILES[currentLang], { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load vocab.csv (${res.status})`);

  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);

  // header
  const headerRaw = splitCSVLine(lines[0] || "").map(x => (x || "").trim().toLowerCase());
  // accept typo "vietnamse" too
  const hasHeader =
    headerRaw.includes("english") &&
    (headerRaw.includes("vietnamese") || headerRaw.includes("vietnamse"));

  const dataLines = hasHeader ? lines.slice(1) : lines;

  const idIdx = headerRaw.indexOf("id");
  const enIdx = headerRaw.indexOf("english");
  const viIdx = headerRaw.indexOf("vietnamese") >= 0 ? headerRaw.indexOf("vietnamese") : headerRaw.indexOf("vietnamse");

  const used = new Map(); // ensure unique ids if generated

  vocab = dataLines.map((line) => {
    const cols = splitCSVLine(line);

    // If no header: assume [english, vietnamese]
    let en = "";
    let vi = "";
    let id = "";

    if (hasHeader) {
      if (enIdx >= 0) en = (cols[enIdx] || "").trim();
      if (viIdx >= 0) {
        // keep commas in meaning: join remaining cols from viIdx
        vi = (cols.slice(viIdx).join(",") || "").trim();
      }
      if (idIdx >= 0) id = (cols[idIdx] || "").trim();
    } else {
      if (cols.length < 2) return null;
      en = (cols[0] || "").trim();
      vi = (cols.slice(1).join(",") || "").trim();
    }

    if (!en || !vi) return null;

    if (!id) id = makeIdFromEnglish(en);

    // ensure unique
    if (used.has(id)) {
      const n = used.get(id) + 1;
      used.set(id, n);
      id = `${id}_${n}`;
    } else {
      used.set(id, 1);
    }

    return { id, en, vi };
  }).filter(Boolean);

  console.log("VOCAB LOADED:", vocab.length);

  loadSettings();
  loadProgress();

  // --- migrate old progress keys (english) -> new keys (id)
  const enToId = {};
  for (const item of vocab) enToId[item.en] = item.id;

  let migrated = false;
  for (const k of Object.keys(progress)) {
    if (enToId[k] && !progress[enToId[k]]) {
      progress[enToId[k]] = progress[k];
      delete progress[k];
      migrated = true;
    }
  }
  if (migrated) saveProgress();

  for (const item of vocab) ensureCard(item.id);
  saveProgress();

  document.getElementById("goalInput").value = String(settings.dailyGoal);
  setModeUI();
  setDeckUI();
  setDirectionUI();
  applyTheme(); 

  // wire import
  const input = document.getElementById("importFile");
  input.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) handleImportFile(f);
  });

  // Flash: tap + swipe
  const cardEl = document.getElementById("card");
  cardEl.addEventListener("click", (e) => {
    // avoid flipping when clicking buttons
    const tag = e.target?.tagName;
    if (tag === "BUTTON" || tag === "INPUT") return;
    if (settings.mode === "flash") toggleFlashFlip();
  });

  cardEl.addEventListener("touchstart", (e) => {
    if (settings.mode !== "flash") return;
    touchStartX = e.touches[0].clientX;
  }, { passive: true });

  cardEl.addEventListener("touchend", (e) => {
    if (settings.mode !== "flash") return;
    if (touchStartX === null) return;
    const endX = e.changedTouches[0].clientX;
    const dx = endX - touchStartX;
    touchStartX = null;

    if (Math.abs(dx) < 50) return;
    if (dx > 0) flashGotIt();
    else flashMissed();
  }, { passive: true });

  order = buildDeckIndices();
  nextCard();

  if (window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener?.("change", () => {
    if (settings.theme === "system") applyTheme();
  });
}

}

loadVocabCSV().catch(err => {
  console.error(err);
  document.getElementById("prompt").innerText = "No vocab loaded.";
  document.getElementById("word").innerText = "Check data/gmat_en_vi.csv and reload.";
});

document.getElementById("btnENVI")?.addEventListener("click", () => {
  currentLang = "en_vi";
  loadVocabCSV();
});

document.getElementById("btnENKO")?.addEventListener("click", () => {
  currentLang = "en_ko";
  loadVocabCSV();
});

document.getElementById("btnENZH")?.addEventListener("click", () => {
  currentLang = "en_zh";
  loadVocabCSV();
});