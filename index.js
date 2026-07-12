const MAX_TIMEOUT = 2147483647;
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const cron = require('node-cron');
const { logActivity, savePieChart, saveMonthlyCalendar, getTodayActivities, formatJST,
  startSleepSession, stopSleepSession, addPendingSleep, markPendingSleepPhoneUsed, clearPendingSleep, getWeeklySleepTotals, loadSleepSessions,
  exportSleepSessions, importSleepSessions } = require('./activity.js');

let say;
try {
  say = require('say');
} catch (error) {
  say = null;
}

const activeJobs = [];
const SLEEP_GRACE_MINUTES = 15; // user has this many minutes to use phone after reminder
const DEFAULT_VOLUME = 75; // 0-100
const PRIORITY_COLORS = {
  urgent: '\u001b[31m',
  high: '\u001b[33m',
  normal: '\u001b[32m',
  low: '\u001b[34m',
  reset: '\u001b[0m'
};
const ANSI_COLOR_CODES = {
  black: '\u001b[30m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  white: '\u001b[37m'
};

const PENDING_SLEEP_PATH = path.join(__dirname, 'pending_sleep.json');
const PENDING_WAKE_PATH = path.join(__dirname, 'pending_wake.json');

function pendingSleepActive() {
  if (!fs.existsSync(PENDING_SLEEP_PATH)) return null;
  try {
    const p = JSON.parse(fs.readFileSync(PENDING_SLEEP_PATH, 'utf8'));
    if (p.expiresAt && new Date() > new Date(p.expiresAt)) {
      try { fs.unlinkSync(PENDING_SLEEP_PATH); } catch (e) {}
      return null;
    }
    return p;
  } catch (e) {
    return null;
  }
}

function pendingWakeActive() {
  if (!fs.existsSync(PENDING_WAKE_PATH)) return null;
  try {
    const p = JSON.parse(fs.readFileSync(PENDING_WAKE_PATH, 'utf8'));
    return p;
  } catch (e) {
    return null;
  }
}

function commandExists(command) {
  try {
    return spawnSync('which', [command]).status === 0;
  } catch (e) {
    return false;
  }
}

function turnPhoneScreenOff() {
  const command = 'adb';
  if (!commandExists(command)) {
    console.error('📵 Screen off unavailable: adb is not installed or not on PATH.');
    return false;
  }

  const args = ['shell', 'input', 'keyevent', '26'];
  try {
    const result = spawnSync(command, args, { stdio: 'ignore', timeout: 5000 });
    if (result.status === 0) {
      console.log('📵 Phone screen turned off via adb.');
      return true;
    }
    console.error('📵 Failed to turn off screen via adb.');
    return false;
  } catch (err) {
    console.error('📵 Error turning off screen:', err.message || err);
    return false;
  }
}

function hasOpenSleepSession() {
  try {
    const sessions = loadSleepSessions();
    return sessions.some(s => !s.end);
  } catch (e) {
    return false;
  }
}

function hasWakeScheduled() {
  return activeJobs.some(j => j.type === 'wake');
}

function hasSleepScheduledFor(time) {
  return activeJobs.some(j => j.type === 'sleep' && j.time === time);
}

function safeSetTimeout(ms, cb) {
  if (ms <= 0) return setTimeout(cb, 0);
  if (ms > MAX_TIMEOUT) {
    return setTimeout(() => safeSetTimeout(ms - MAX_TIMEOUT, cb), MAX_TIMEOUT);
  }
  return setTimeout(cb, ms);
}

function getPriorityColor(priority = 'normal') {
  return PRIORITY_COLORS[priority] || PRIORITY_COLORS.normal;
}

function normalizePriority(priority = 'normal') {
  const normalized = String(priority || 'normal').toLowerCase();
  return normalized === 'urgent' ? 'urgent' : normalized === 'high' ? 'high' : normalized === 'low' ? 'low' : normalized === 'normal' ? 'normal' : normalized;
}

function resolvePriorityColor(color) {
  if (!color) return null;
  const normalized = String(color).trim().toLowerCase();
  if (ANSI_COLOR_CODES[normalized]) return ANSI_COLOR_CODES[normalized];
  if (/^\d{1,2}$/.test(normalized)) return `\u001b[${normalized}m`;
  return null;
}

function registerCustomPriority(name, color) {
  const normalizedName = normalizePriority(name);
  if (!normalizedName || ['urgent', 'high', 'normal', 'low'].includes(normalizedName)) {
    return null;
  }

  const resolvedColor = resolvePriorityColor(color) || ANSI_COLOR_CODES.magenta;
  PRIORITY_COLORS[normalizedName] = resolvedColor;
  return normalizedName;
}

function formatPriorityLabel(priority = 'normal') {
  return normalizePriority(priority);
}

function logPriorityMessage(message, priority = 'normal') {
  const label = formatPriorityLabel(priority);
  const color = getPriorityColor(label);
  console.log(`${color}[${label}]${PRIORITY_COLORS.reset} ${message}`);
}

function removeActiveJob(task) {
  const index = activeJobs.findIndex(job => job.task === task);
  if (index >= 0) {
    activeJobs.splice(index, 1);
  }
}

function listScheduledJobs(filterPriority = null) {
  const normalizedFilter = filterPriority ? normalizePriority(filterPriority) : null;
  const jobs = activeJobs.filter(job => !normalizedFilter || normalizePriority(job.priority) === normalizedFilter);
  if (jobs.length === 0) {
    const suffix = normalizedFilter ? ` for ${normalizedFilter}` : '';
    console.log(`No scheduled jobs found${suffix}.`);
    return [];
  }

  console.log(`Scheduled jobs${normalizedFilter ? ` (${normalizedFilter})` : ''}:`);
  jobs.forEach(job => {
    const typeLabel = job.type === 'sleep' ? 'sleep' : job.type === 'wake' ? 'wake' : 'notification';
    const detail = job.type === 'sleep' || job.type === 'wake'
      ? `${typeLabel} ${job.time}`
      : `${typeLabel} ${job.label || job.time}`;
    logPriorityMessage(`- ${detail}`, job.priority);
  });
  return jobs;
}

function parseDateTime(dateStr, timeStr) {
  if (dateStr === 'now') {
    const offsetMs = Number(timeStr) || 3000;
    return new Date(Date.now() + offsetMs);
  }

  const [y, m, d] = dateStr.split('-').map(Number);
  const tParts = (timeStr || '00:00:00').split(':').map(Number);
  const hh = tParts[0] || 0;
  const mm = tParts[1] || 0;
  const ss = tParts[2] || 0;
  return new Date(y, (m || 1) - 1, d || 1, hh, mm, ss);
}

function parseBathDateTime(bathTime) {
  if (!bathTime) return null;

  if (/^\d{2}:\d{2}(:\d{2})?$/.test(bathTime)) {
    const now = new Date();
    const [hh, mm, ss = '00'] = bathTime.split(':');
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(hh), Number(mm), Number(ss));
  }

  const direct = new Date(bathTime);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(bathTime)) {
    return new Date(`${bathTime}T00:00:00`);
  }

  return null;
}

function speakNotification(message, voice = null, speed = 1) {
  if (!say) {
    console.log('ℹ️ Voice support unavailable: install "say" or run in a supported environment.');
    return;
  }

  // Check for a TTS binary present on the system to avoid unhandled spawn errors
  const ttsCandidates = ['say', 'festival', 'espeak', 'spd-say', 'flite'];
  const hasTts = ttsCandidates.some(cmd => {
    try {
      const res = spawnSync('which', [cmd]);
      return res.status === 0;
    } catch (e) {
      return false;
    }
  });

  if (!hasTts) {
    console.log('ℹ️ Voice support unavailable: no TTS binary found on PATH.');
    return;
  }

  try {
    const proc = say.speak(message, voice || undefined, speed, (err) => {
      if (err) {
        const errText = err && err.message ? err.message : String(err);
        console.error('🔈 Voice error:', errText);
        if (errText.includes('spawn') || errText.includes('ENOENT')) {
          console.error('🔧 TTS binary not found. Use a supported TTS engine or remove --voice.');
        }
      }
    });

    // Some TTS backends may emit 'error' on the spawned child process
    // before the callback is invoked; attach a handler to avoid crashing.
    try {
      if (proc && typeof proc.on === 'function') {
        proc.on('error', (err) => {
          const errText = err && err.message ? err.message : String(err);
          console.error('🔈 Voice child error:', errText);
          if (errText.includes('spawn') || errText.includes('ENOENT')) {
            console.error('🔧 TTS binary not found. Use a supported TTS engine or remove --voice.');
          }
        });
      }
    } catch (e) {
      // ignore attaching handler errors
    }
  } catch (error) {
    const errText = error && error.message ? error.message : String(error);
    console.error('🔈 Voice failed:', errText);
    if (errText.includes('spawn') || errText.includes('ENOENT')) {
      console.error('🔧 TTS binary not found. Use a supported TTS engine or remove --voice.');
    }
  }
}

function sleepReminder(bedtime, music = null, voice = null, volume = DEFAULT_VOLUME, priority = 'normal') {
  const [hh, mm] = bedtime.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    console.error('Invalid bedtime format. Use HH:MM (e.g., 23:00)');
    return null;
  }

  const cronExpression = `${mm} ${hh} * * *`;
  const task = bedtime === 'stop' ? null : cron.schedule(cronExpression, () => {
    const now = new Date();
    logPriorityMessage(`💤 [${now.toLocaleTimeString()}] Bedtime reminder: It's ${bedtime} - Time to sleep!`, priority);
    
    if (music) {
      playMusicNotification(music, volume);
    } else {
      speakNotification(`It's ${bedtime}. Time to sleep!`, voice);
    }

    // Create a pending sleep marker so other processes (phone-used CLI) can mark usage.
    const reminderISO = new Date().toISOString();
    const expiresISO = new Date(Date.now() + SLEEP_GRACE_MINUTES * 60000).toISOString();
    try {
      addPendingSleep(reminderISO, expiresISO);
    } catch (e) {
      // ignore
    }

    // After grace period, if phone was not used, record sleep start at reminder time.
    safeSetTimeout(SLEEP_GRACE_MINUTES * 60000, () => {
      // Read pending file to check
      try {
        const pending = fs.existsSync(path.join(__dirname, 'pending_sleep.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'pending_sleep.json'), 'utf8')) : null;
        if (pending && pending.phoneUsed) {
          console.log('📵 Phone used after reminder — not auto-starting sleep.');
          // clear pending
          clearPendingSleep();
          return;
        }
        // Auto-start sleep session at reminder time
        startSleepSession(reminderISO);
        console.log(`🛌 Auto-recorded sleep start at ${new Date(reminderISO).toLocaleString('ja-JP')}`);
        clearPendingSleep();

        // If the user still hasn't used the phone, attempt to turn off the screen.
        if (!pending || !pending.phoneUsed) {
          turnPhoneScreenOff();
        }
      } catch (err) {
        // ignore
        clearPendingSleep();
      }
    });
  }, {
    runOnInit: false
  });

  if (task) {
    activeJobs.push({ task, type: 'sleep', time: bedtime, priority });
    console.log(`✅ Sleep reminder scheduled for ${bedtime} every day`);
    return task;
  }
  return null;
}

function stopSleepReminder() {
  if (activeJobs.length === 0) {
    console.log('No active reminders.');
    return;
  }

  activeJobs.forEach(({ task, type, time }) => {
    try { task.stop(); } catch (e) {}
    if (type === 'wake') {
      console.log(`⏹️  Stopped wake alarm for ${time}`);
    } else {
      console.log(`⏹️  Stopped sleep reminder for ${time}`);
    }
  });
  activeJobs.length = 0;
}

function playMusicNotification(musicFile, volume = DEFAULT_VOLUME) {
  if (!musicFile) {
    console.log('ℹ️ No music file specified.');
    return;
  }

  const filepath = path.resolve(musicFile);
  if (!fs.existsSync(filepath)) {
    console.error(`🎵 Music file not found: ${filepath}`);
    return;
  }

  console.log(`🎵 Playing: ${path.basename(filepath)}`);

  const players = [
    ['ffplay', ['-nodisp', '-autoexit', '-volume', String(Math.max(0, Math.min(100, volume))), filepath]],
    ['paplay', ['--volume=' + (Math.max(0, Math.min(100, volume)) / 100).toFixed(2), filepath]],
    ['mplayer', ['-really-quiet', '-volume', String(Math.max(0, Math.min(100, volume))), filepath]],
    ['mpg123', ['-f', String(Math.round(Math.max(0, Math.min(100, volume)) * 327.67)), filepath]],
    ['aplay', [filepath]]
  ];

  const tryNextPlayer = (index) => {
    if (index >= players.length) {
      console.error('🎵 No audio player found. Install ffmpeg, alsa-utils, or pulseaudio.');
      return;
    }

    const [player, args] = players[index];
    try {
      const proc = spawn(player, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        timeout: 60000
      });

      proc.on('error', (err) => {
        if (err.code === 'ENOENT') {
          tryNextPlayer(index + 1);
        } else {
          console.error(`🎵 Audio error (${player}):`, err.message);
        }
      });

      proc.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`🎵 ${player} exited with code ${code}`);
        }
      });
    } catch (error) {
      tryNextPlayer(index + 1);
    }
  };

  tryNextPlayer(0);
}

// Play a short generic notification sound using available players.
function playNotificationSound(volume = DEFAULT_VOLUME) {
  const vol = Math.max(0, Math.min(100, Number(volume) || DEFAULT_VOLUME));
  const tryCmd = (cmd, args) => {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore', detached: false, timeout: 10000 });
      return p && typeof p.on === 'function';
    } catch (e) {
      return false;
    }
  };

  // Prefer ffplay with a generated sine tone
  if (commandExists('ffplay')) {
    tryCmd('ffplay', ['-nodisp', '-autoexit', '-f', 'lavfi', '-i', `sine=frequency=1000:duration=0.6`, '-volume', String(Math.max(0, Math.min(100, vol)))]);
    return;
  }

  // Try sox/play
  if (commandExists('play')) {
    tryCmd('play', ['-n', 'synth', '0.6', 'sin', '1000', 'vol', String(Math.max(0, Math.min(100, vol))) + '%']);
    return;
  }

  // Try paplay with common sound file
  const common = '/usr/share/sounds/freedesktop/stereo/complete.oga';
  if (fs.existsSync(common) && commandExists('paplay')) {
    tryCmd('paplay', [common]);
    return;
  }

  // Fallback: console bell
  try { process.stdout.write('\u0007'); } catch (e) {}
}

function scheduleNotification(dateStr, timeStr, task, voice = null, music = null, volume = DEFAULT_VOLUME, priority = 'normal') {
  const target = parseDateTime(dateStr, timeStr);
  const now = new Date();
  const ms = target - now;
  if (ms <= 0) {
    console.log(`⚠️  指定時刻は過去です: ${target.toString()}`);
    return null;
  }

  const norm = normalizePriority(priority);
  logPriorityMessage(`Scheduled: ${task} at ${target.toString()} (in ${Math.round(ms / 1000)}s)`, norm);

  // Consider high/urgent alerts and boost their effective volume; prefer a short beep
  const isHighAlert = norm === 'high' || norm === 'urgent';

  const timeoutId = safeSetTimeout(ms, () => {
    removeActiveJob(timeoutId);
    logPriorityMessage(`🔔 Notification: ${task} — ${target.toLocaleString()}`, norm);

    const baseVol = Number.isNaN(Number(volume)) ? DEFAULT_VOLUME : Number(volume);
    let effVolume = baseVol;
    if (isHighAlert) {
      effVolume = Math.min(100, baseVol + 15);
    } else if (norm === 'low') {
      effVolume = Math.max(0, baseVol - 15);
    }

    if (isHighAlert && !music) {
      // Play a short generic notification sound at boosted volume, and optionally TTS
      playNotificationSound(effVolume);
      if (voice) speakNotification(task, voice);
    } else if (music) {
      playMusicNotification(music, effVolume);
    } else {
      const fallbackVoice = voice || null;
      speakNotification(task, fallbackVoice);
    }
  });

  activeJobs.push({ task: timeoutId, type: 'notification', time: target.toISOString(), label: task, priority: norm });
  return ms;
}

function demoSoon() {
  const d = new Date(Date.now() + 3000);
  const date = d.toISOString().slice(0,10);
  const time = d.toTimeString().slice(0,8);
  console.log('Demo scheduling (3s)…');
  scheduleNotification(date, time, 'Demo task', null, null, DEFAULT_VOLUME);
}

function setWakeAlarm(wakeTime, music = null, voice = null, volume = DEFAULT_VOLUME, priority = 'normal') {
  const [hh, mm] = wakeTime.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) {
    console.error('Invalid wake time. Use HH:MM');
    return null;
  }
  const cronExpression = `${mm} ${hh} * * *`;
  const task = cron.schedule(cronExpression, () => {
    const now = new Date();
    logPriorityMessage(`⏰ [${now.toLocaleTimeString()}] Wake alarm: ${wakeTime}`, priority);
    if (music) {
      playMusicNotification(music, volume);
    } else {
      speakNotification('Wake up!', voice);
    }
    // create a pending wake marker so user can stop and record wake time
    try {
      fs.writeFileSync(path.join(__dirname, 'pending_wake.json'), JSON.stringify({ alarm: new Date().toISOString(), awaitingStop: true }, null, 2));
    } catch (e) {}
  }, { runOnInit: false });

  activeJobs.push({ task, type: 'wake', time: wakeTime, priority });
  console.log(`✅ Wake alarm scheduled for ${wakeTime} every day`);
  return task;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let voice = null;
  let music = null;
  let sleep = null;
  let sleepSync = undefined;
  let sleepSyncImport = null;
  let bathTime = null;
  let volume = DEFAULT_VOLUME;
  let priority = 'normal';
  let customPriorityName = null;
  let customPriorityColor = null;
  let logActivityCmd = null;
  let showChart = false;
  let showCalendar = false;
  let calendarTarget = null;
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--voice=')) {
      voice = arg.slice('--voice='.length);
    } else if (arg === '--voice' && args[i + 1]) {
      voice = args[++i];
    } else if (arg.startsWith('--music=')) {
      music = arg.slice('--music='.length);
    } else if (arg === '--music' && args[i + 1]) {
      music = args[++i];
    } else if (arg.startsWith('--sleep=')) {
      sleep = arg.slice('--sleep='.length) || '22:00';
    } else if (arg === '--sleep') {
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        sleep = args[++i];
      } else {
        sleep = '22:00';
      }
    } else if (arg.startsWith('--bath=')) {
      bathTime = arg.slice('--bath='.length);
    } else if (arg === '--bath' && args[i + 1]) {
      bathTime = args[++i];
    } else if (arg === '--log-activity' && args[i + 1] && args[i + 2]) {
      logActivityCmd = {
        category: args[++i],
        duration: Number(args[++i]),
        details: args.slice(i + 1).join(' ')
      };
      break;
    } else if (arg.startsWith('--volume=')) {
      volume = Number(arg.slice('--volume='.length));
      if (Number.isNaN(volume)) volume = DEFAULT_VOLUME;
    } else if (arg === '--volume' && args[i + 1]) {
      volume = Number(args[++i]);
      if (Number.isNaN(volume)) volume = DEFAULT_VOLUME;
    } else if (arg.startsWith('--priority=')) {
      priority = normalizePriority(arg.slice('--priority='.length));
    } else if (arg === '--priority' && args[i + 1]) {
      priority = normalizePriority(args[++i]);
    } else if (arg.startsWith('--custom-priority=')) {
      customPriorityName = arg.slice('--custom-priority='.length);
      priority = normalizePriority(customPriorityName);
    } else if (arg === '--custom-priority' && args[i + 1]) {
      customPriorityName = args[++i];
      priority = normalizePriority(customPriorityName);
    } else if (arg.startsWith('--priority-color=')) {
      customPriorityColor = arg.slice('--priority-color='.length);
    } else if (arg === '--priority-color' && args[i + 1]) {
      customPriorityColor = args[++i];
    } else if (arg.startsWith('--importance=')) {
      priority = normalizePriority(arg.slice('--importance='.length));
    } else if (arg === '--importance' && args[i + 1]) {
      priority = normalizePriority(args[++i]);
    } else if (arg === '--show-chart') {
      showChart = true;
    } else if (arg === '--list-schedules' || arg === '--list-priority') {
      const filter = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : null;
      listScheduledJobs(filter);
      return;
    } else if (arg === '--show-calendar') {
      showCalendar = true;
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        calendarTarget = args[++i];
      }
    } else if (arg.startsWith('--sleep-sync=')) {
      sleepSync = arg.slice('--sleep-sync='.length) || '';
    } else if (arg === '--sleep-sync') {
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        sleepSync = args[++i];
      } else {
        sleepSync = '';
      }
    } else if (arg.startsWith('--sleep-sync-import=')) {
      sleepSyncImport = arg.slice('--sleep-sync-import='.length);
    } else if (arg === '--sleep-sync-import' && args[i + 1]) {
      sleepSyncImport = args[++i];
    } else if (arg === '--phone-used') {
      // mark pending sleep as phone-used
      const ok = markPendingSleepPhoneUsed();
      console.log(ok ? 'Recorded phone use after reminder.' : 'No pending sleep reminder found.');
      return;
    } else if (arg === '--confirm-sleep') {
      // If there's a pending reminder, use that reminder time as the sleep start
      let start;
      try {
        const pendingPath = path.join(__dirname, 'pending_sleep.json');
        if (fs.existsSync(pendingPath)) {
          const p = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
          if (p && p.reminder) {
            start = startSleepSession(p.reminder);
          } else {
            start = startSleepSession();
          }
        } else {
          start = startSleepSession();
        }
      } catch (e) {
        start = startSleepSession();
      }
      clearPendingSleep();
      console.log(`Recorded sleep start at ${new Date(start).toLocaleString('ja-JP')}`);
      return;
    } else if (arg === '--wake-stop') {
      // If a pending wake alarm exists, use its alarm time as the stop time
      const pendingWakePath = path.join(__dirname, 'pending_wake.json');
      let stopISO = null;
      if (fs.existsSync(pendingWakePath)) {
        try {
          const pw = JSON.parse(fs.readFileSync(pendingWakePath, 'utf8'));
          if (pw && pw.alarm) stopISO = pw.alarm;
          try { fs.unlinkSync(pendingWakePath); } catch (e) {}
        } catch (e) {
          // ignore
        }
      }
      const session = stopSleepSession(stopISO);
      if (session) console.log(`Recorded wake at ${new Date(session.end).toLocaleString('ja-JP')}`);
      else console.log('No active sleep session found.');
      return;
    } else if (arg === '--set-wake' && args[i + 1]) {
      const wakeTime = args[++i];
      // Pre-checks to avoid duplicate wake alarms or conflicting pending wake
      if (hasWakeScheduled()) {
        console.error('⚠️  既にウェイクアラームがスケジュールされています。先に停止してください。');
        return;
      }
      if (pendingWakeActive()) {
        console.error('⚠️  保留中のウェイクアラームが既に存在します。先に処理するか削除してください。');
        return;
      }
      setWakeAlarm(wakeTime, music, voice, volume, priority);
      return;
    } else if (arg === '--stop-sleep') {
      stopSleepReminder();
      return;
    } else {
      positional.push(arg);
    }
  }

  if (customPriorityName) {
    registerCustomPriority(customPriorityName, customPriorityColor || 'magenta');
    if (priority !== customPriorityName) {
      priority = normalizePriority(customPriorityName);
    }
  }

  if (logActivityCmd) {
    logActivity(logActivityCmd.category, logActivityCmd.duration, logActivityCmd.details);
  } else if (showChart) {
    const chartFile = savePieChart();
    console.log(`\n📊 Open the pie chart in your browser: file://${path.resolve(chartFile)}`);
  } else if (showCalendar) {
    const calendarFile = saveMonthlyCalendar(null, calendarTarget);
    console.log(`\n🗓️ Open the calendar in your browser: file://${path.resolve(calendarFile)}`);
  } else if (sleepSyncImport) {
    const result = importSleepSessions(sleepSyncImport);
    if (!result) {
      console.error('❌ SleepSync import failed: file not found or invalid format.');
    } else {
      console.log(`✅ Imported ${result.added} sleep sessions from ${result.filepath}. Total sessions: ${result.total}`);
    }
    return;
  } else if (sleepSync !== undefined) {
    const outputFile = sleepSync || path.join(__dirname, 'sleep_sessions_sync.json');
    const file = exportSleepSessions(outputFile);
    console.log(`✅ Sleep sessions exported to: ${file}`);
    return;
  } else if (sleep) {
    // Pre-checks to avoid conflicts
    if (hasOpenSleepSession()) {
      console.error('⚠️  既に開始済みの睡眠セッションがあります。新しいスリープリマインダーを登録できません。');
      return;
    }
    const pending = pendingSleepActive();
    if (pending) {
      console.error('⚠️  有効な保留スリープリマインダーが既に存在します。先に処理するか削除してください。');
      console.log(`保留リマインダー: ${JSON.stringify(pending)}`);
      return;
    }
    if (hasSleepScheduledFor(sleep)) {
      console.error('⚠️  同じ時刻のスリープリマインダーが既にスケジュールされています。');
      return;
    }
    sleepReminder(sleep, music, voice, volume, priority);
    console.log('Press Ctrl+C to stop...');
  } else if (positional.length === 0) {
    console.log('Usage: node index.js <YYYY-MM-DD|now> <HH:MM[:SS]|ms-for-now> <task...> [--voice <voice>] [--music <file>] [--priority low|normal|high|urgent|custom] [--custom-priority <name>] [--priority-color <color>]');
    console.log('Example: node index.js 2026-06-16 14:30 "Meeting" --voice "kyoko" --priority high');
    console.log('With music: node index.js now 5000 "Break time" --music ./music.mp3');
    console.log('Sleep reminder (daily): node index.js --sleep 23:00 --music ./healing.wav --priority urgent');
    console.log('Add one custom priority color: node index.js now 3000 "Review" --custom-priority review --priority-color cyan');
    console.log('List scheduled jobs by priority: node index.js --list-schedules high');
    console.log('Stop sleep reminder: node index.js --stop-sleep');
    console.log('');
    console.log('Activity tracking:');
    console.log('Log activity: node index.js --log-activity "Work" 120 "Coding project"');
    console.log('Show pie chart: node index.js --show-chart');
    console.log('Show calendar: node index.js --show-calendar [YYYY-MM]');
    console.log('Demo: node index.js now 3000');
  } else if (positional[0] === 'now') {
    const ms = Number(positional[1]) || 3000;
    scheduleNotification('now', String(ms), positional.slice(2).join(' ') || 'Immediate task', voice, music, volume, priority);
  } else if (positional.length >= 3) {
    scheduleNotification(positional[0], positional[1], positional.slice(2).join(' '), voice, music, volume, priority);
  } else {
    console.log('Invalid arguments. See usage.');
  }
}

module.exports = { scheduleNotification, sleepReminder, stopSleepReminder, demoSoon, listScheduledJobs };
