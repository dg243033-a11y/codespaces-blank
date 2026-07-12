const fs = require('fs');
const path = require('path');

const ACTIVITIES_FILE = path.join(__dirname, 'activities.json');
const SLEEP_FILE = path.join(__dirname, 'sleep_sessions.json');
const PENDING_SLEEP_FILE = path.join(__dirname, 'pending_sleep.json');
const JST_OFFSET = 9 * 60 * 60 * 1000; // 9 hours in milliseconds

// Helper to get JST date string
function getJSTDate(date) {
  const jstDate = new Date(date.getTime() + JST_OFFSET);
  return jstDate.toISOString().slice(0, 10);
}

// Helper to format time in JST
function formatJST(date) {
  const jstDate = new Date(date.getTime() + JST_OFFSET);
  return jstDate.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// Load activities from file
function loadActivities() {
  if (!fs.existsSync(ACTIVITIES_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(ACTIVITIES_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function loadSleepSessions() {
  if (!fs.existsSync(SLEEP_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SLEEP_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveSleepSessions(sessions) {
  fs.writeFileSync(SLEEP_FILE, JSON.stringify(sessions, null, 2));
}

function addPendingSleep(reminderISO, expiresISO) {
  const obj = { reminder: reminderISO, expiresAt: expiresISO, phoneUsed: false };
  fs.writeFileSync(PENDING_SLEEP_FILE, JSON.stringify(obj, null, 2));
}

function markPendingSleepPhoneUsed() {
  if (!fs.existsSync(PENDING_SLEEP_FILE)) return false;
  try {
    const obj = JSON.parse(fs.readFileSync(PENDING_SLEEP_FILE, 'utf8'));
    // If pending has expired, clear and return false
    if (obj.expiresAt && new Date() > new Date(obj.expiresAt)) {
      try { fs.unlinkSync(PENDING_SLEEP_FILE); } catch (e) {}
      return false;
    }
    obj.phoneUsed = true;
    obj.usedAt = new Date().toISOString();
    fs.writeFileSync(PENDING_SLEEP_FILE, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

function clearPendingSleep() {
  if (fs.existsSync(PENDING_SLEEP_FILE)) fs.unlinkSync(PENDING_SLEEP_FILE);
}

function startSleepSession(startISO = null) {
  const sessions = loadSleepSessions();
  const start = startISO || new Date().toISOString();
  sessions.push({ start, end: null });
  saveSleepSessions(sessions);
  return start;
}

function stopSleepSession(stopISO = null) {
  const sessions = loadSleepSessions();
  const stop = stopISO || new Date().toISOString();
  // Find last open session
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (!sessions[i].end) {
      sessions[i].end = stop;
      saveSleepSessions(sessions);
      return sessions[i];
    }
  }
  return null;
}

function getWeekRangeJST(date = new Date(), weekOffset = 0) {
  // weekOffset 0 = this week, 1 = previous week
  const d = new Date(date.getTime() + JST_OFFSET);
  const day = d.getUTCDay();
  // ISO week start Monday: get difference to Monday
  const isoDay = day === 0 ? 7 : day; // Sunday->7
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (isoDay - 1) - weekOffset * 7);
  monday.setUTCHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  // convert back from JST shift
  const start = new Date(monday.getTime() - JST_OFFSET);
  const end = new Date(sunday.getTime() - JST_OFFSET);
  return { start, end };
}

function minutesBetweenISO(startISO, endISO) {
  const s = new Date(startISO);
  const e = new Date(endISO);
  return Math.max(0, Math.round((e - s) / 60000));
}

function getWeeklySleepTotals() {
  const sessions = loadSleepSessions();
  const now = new Date();
  const thisWeek = getWeekRangeJST(now, 0);
  const lastWeek = getWeekRangeJST(now, 1);

  const sumForRange = (range) => {
    let total = 0;
    sessions.forEach(s => {
      if (!s.start) return;
      const start = new Date(s.start);
      if (start >= range.start && start <= range.end && s.end) {
        total += minutesBetweenISO(s.start, s.end);
      }
    });
    return total;
  };

  const current = sumForRange(thisWeek);
  const previous = sumForRange(lastWeek);
  let percentChange = null;
  if (previous === 0) {
    percentChange = null;
  } else {
    percentChange = ((current - previous) / previous) * 100;
  }
  return { current, previous, percentChange };
}

function getSleepMinutesForDate(dateString) {
  const sessions = loadSleepSessions();
  const startOfDay = new Date(`${dateString}T00:00:00+09:00`);
  const endOfDay = new Date(`${dateString}T23:59:59.999+09:00`);
  let total = 0;

  sessions.forEach((s) => {
    if (!s.start || !s.end) return;
    const start = new Date(s.start);
    const end = new Date(s.end);
    const overlapStart = Math.max(start.getTime(), startOfDay.getTime());
    const overlapEnd = Math.min(end.getTime(), endOfDay.getTime());
    if (overlapEnd > overlapStart) {
      total += Math.max(0, Math.round((overlapEnd - overlapStart) / 60000));
    }
  });

  return total;
}

function exportSleepSessions(outputFile = null) {
  const sessions = loadSleepSessions();
  const filename = outputFile ? path.resolve(outputFile) : path.join(__dirname, 'sleep_sessions_sync.json');
  fs.writeFileSync(filename, JSON.stringify(sessions, null, 2));
  return filename;
}

function importSleepSessions(inputFile) {
  if (!inputFile) return null;
  const filename = path.resolve(inputFile);
  if (!fs.existsSync(filename)) return null;

  try {
    const imported = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(imported)) return null;

    const sessions = loadSleepSessions();
    const existingKeys = new Set(sessions.map((s) => `${s.start || ''}|${s.end || ''}`));
    let added = 0;

    imported.forEach((session) => {
      if (!session || typeof session.start !== 'string') return;
      const key = `${session.start}|${session.end || ''}`;
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        sessions.push(session);
        added += 1;
      }
    });

    if (added > 0) {
      saveSleepSessions(sessions);
    }

    return { added, total: sessions.length, filepath: filename };
  } catch (e) {
    return null;
  }
}

// Save activities to file
function saveActivities(activities) {
  fs.writeFileSync(ACTIVITIES_FILE, JSON.stringify(activities, null, 2));
}

// Log an activity
function logActivity(category, duration, details = '') {
  const activities = loadActivities();
  const today = getJSTDate(new Date());

  if (!activities[today]) {
    activities[today] = [];
  }

  const list = activities[today];
  const normalizedDetails = details || '';
  let totalDuration = Number(duration || 0);
  let firstIndex = -1;

  // Collect all matching entries and merge them into one.
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (item.category === category && (item.details || '') === normalizedDetails) {
      totalDuration += Number(item.duration || 0);
      firstIndex = i;
      list.splice(i, 1);
    }
  }

  if (firstIndex >= 0) {
    const mergedEntry = {
      category,
      duration: totalDuration,
      details: normalizedDetails,
      timestamp: new Date().toISOString()
    };
    list.splice(firstIndex, 0, mergedEntry);
    saveActivities(activities);
    console.log(`ℹ️ Merged with existing: ${category} (+${duration}min) => ${totalDuration}min total`);
    return;
  }

  list.push({
    category,
    duration, // in minutes
    details: normalizedDetails,
    timestamp: new Date().toISOString()
  });

  saveActivities(activities);
  console.log(`✅ Logged: ${category} (${duration}min) - ${normalizedDetails}`);
}

// Get today's activities
function getTodayActivities() {
  const activities = loadActivities();
  const today = getJSTDate(new Date());
  return activities[today] || [];
}

// Generate pie chart HTML
function generatePieChart(date = null) {
  const activities = loadActivities();
  const targetDate = date ? getJSTDate(new Date(date)) : getJSTDate(new Date());
  const dayActivities = activities[targetDate] || [];
  const sleepMinutes = getSleepMinutesForDate(targetDate);

  if (dayActivities.length === 0 && sleepMinutes === 0) {
    return `<html><body><p>No activities recorded for ${targetDate}</p></body></html>`;
  }

  // Aggregate by category
  const categoryMap = {};
  dayActivities.forEach(activity => {
    if (!categoryMap[activity.category]) {
      categoryMap[activity.category] = 0;
    }
    categoryMap[activity.category] += activity.duration;
  });

  // Add sleep duration from actual sleep sessions if not already present.
  if (sleepMinutes > 0 && !categoryMap['Sleep']) {
    categoryMap['Sleep'] = sleepMinutes;
  }

  const totalTrackedMinutes = Object.values(categoryMap).reduce((sum, value) => sum + value, 0);
  if (totalTrackedMinutes > 0 && totalTrackedMinutes < 24 * 60) {
    categoryMap['Other'] = (categoryMap['Other'] || 0) + (24 * 60 - totalTrackedMinutes);
  }

  const categories = Object.keys(categoryMap);
  const durations = Object.values(categoryMap);
  const colors = [
    '#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF',
    '#FF9F40', '#FF6384', '#C9CBCF', '#4BC0C0', '#FF6384'
  ];

  const chartData = categories.map((cat, i) => ({
    label: cat,
    value: durations[i],
    color: colors[i % colors.length]
  }));

  const todayString = targetDate;
  const yesterdayDate = new Date(new Date(todayString + 'T00:00:00+09:00').getTime() - 24 * 60 * 60 * 1000);
  const yesterdayString = yesterdayDate.toISOString().slice(0, 10);
  const todaySleep = getSleepMinutesForDate(todayString);
  const yesterdaySleep = getSleepMinutesForDate(yesterdayString);
  const sleepDecrease = yesterdaySleep > 0 ? ((yesterdaySleep - todaySleep) / yesterdaySleep) * 100 : null;
  const sleepAlert = sleepDecrease !== null && sleepDecrease >= 10;

  // Weekly sleep summary
  const weekly = getWeeklySleepTotals();
  const fmtMinutes = (m) => `${m}分 (${(m/60).toFixed(1)}時間)`;

  // Generate HTML with Chart.js
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Daily Activity (${targetDate})</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      margin: 0;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
      padding: 30px;
      max-width: 600px;
      width: 100%;
    }
    h1 {
      text-align: center;
      color: #333;
      margin-top: 0;
    }
    .chart-wrapper {
      position: relative;
      height: 400px;
      margin-bottom: 30px;
    }
    .stats {
      background: #f5f5f5;
      padding: 15px;
      border-radius: 8px;
      margin-top: 20px;
    }
    .stat-item {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #ddd;
    }
    .stat-item:last-child {
      border-bottom: none;
    }
    .stat-label {
      font-weight: 500;
      color: #555;
    }
    .stat-value {
      font-weight: bold;
      color: #333;
    }
    .total {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 2px solid #667eea;
      font-size: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎯 1日の活動 (${targetDate})</h1>
    <div class="chart-wrapper">
      <canvas id="pieChart"></canvas>
    </div>
    <div class="stats">
      ${chartData.map(item => `
        <div class="stat-item">
          <span class="stat-label">
            <span style="display: inline-block; width: 12px; height: 12px; background: ${item.color}; border-radius: 2px; margin-right: 8px;"></span>
            ${item.label}
          </span>
          <span class="stat-value">${item.value}分</span>
        </div>
      `).join('')}
      <div class="stat-item total">
        <span class="stat-label">合計</span>
        <span class="stat-value">${durations.reduce((a, b) => a + b, 0)}分 (${(durations.reduce((a, b) => a + b, 0) / 60).toFixed(1)}時間)</span>
      </div>
    </div>
    <div style="margin-top:18px;">
      <h3 style="margin:12px 0 6px 0;">🛌 週間の睡眠（先週比）</h3>
      <div style="background:#fff;padding:12px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.06);">
        <div>今週の睡眠合計: <strong>${fmtMinutes(weekly.current)}</strong></div>
        <div>先週の睡眠合計: <strong>${fmtMinutes(weekly.previous)}</strong></div>
        <div>先週からの変化: <strong>${weekly.percentChange === null ? '比較不能' : (weekly.percentChange.toFixed(1) + '%')}</strong></div>
      </div>
    </div>
    <div style="margin-top:18px;">
      <h3 style="margin:12px 0 6px 0;">🛏 今日の睡眠確認</h3>
      <div style="background:${sleepAlert ? '#ffe5e5' : '#fff'};padding:12px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.06);border:1px solid ${sleepAlert ? '#ff4d4d' : '#e5e7eb'};">
        <div>今日の睡眠: <strong>${fmtMinutes(todaySleep)}</strong></div>
        <div>昨日の睡眠: <strong>${fmtMinutes(yesterdaySleep)}</strong></div>
        <div>昨日比の変化: <strong>${sleepDecrease === null ? '比較不能' : (sleepDecrease.toFixed(1) + '% 減')}</strong></div>
        ${sleepAlert ? '<div style="margin-top:8px;color:#b91c1c;font-weight:700;">⚠️ 昨日より睡眠時間が10%以上減少しています</div>' : ''}
      </div>
    </div>
  </div>

  <script>
    const ctx = document.getElementById('pieChart').getContext('2d');
    const pieChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ${JSON.stringify(categories)},
        datasets: [{
          data: ${JSON.stringify(durations)},
          backgroundColor: ${JSON.stringify(chartData.map(c => c.color))},
          borderColor: '#fff',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              usePointStyle: true,
              padding: 15,
              font: {
                size: 14
              }
            }
          }
        }
      }
    });
  </script>
</body>
</html>`;

  return html;
}

// Save pie chart to HTML file
function savePieChart(outputFile = null, date = null) {
  const filename = outputFile || path.join(__dirname, 'daily_activity.html');
  const html = generatePieChart(date);
  fs.writeFileSync(filename, html);
  console.log(`📊 Pie chart saved to: ${filename}`);
  return filename;
}

function getMonthDateString(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const jstDate = new Date(date.getTime() + JST_OFFSET);
  return jstDate.toISOString().slice(0, 10);
}

function getMonthInfo(target = null) {
  const now = target ? new Date(`${target}-01T00:00:00+09:00`) : new Date(new Date().getTime() + JST_OFFSET);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const firstJST = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0)).getTime() + JST_OFFSET;
  const firstDay = new Date(firstJST).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0, 0, 0, 0)).getUTCDate();
  return { year, month, firstDay, daysInMonth };
}

function generateMonthlyCalendar(target = null) {
  const activities = loadActivities();
  const { year, month, firstDay, daysInMonth } = getMonthInfo(target);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const monthData = {};

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateString = getMonthDateString(year, month, day);
    const dayActivities = activities[dateString] || [];
    const totalMinutes = dayActivities.reduce((sum, a) => sum + (a.duration || 0), 0);
    monthData[dateString] = {
      date: dateString,
      totalMinutes,
      activities: dayActivities
    };
  }

  const labels = ['日', '月', '火', '水', '木', '金', '土'];
  const monthTitle = `${year}年${String(month).padStart(2, '0')}月`;
  const currentMonthKey = `${year}-${String(month).padStart(2, '0')}`;
  const todayKey = getJSTDate(new Date());
  const shouldHighlightToday = !target || target === currentMonthKey;
  const colorMap = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#C9CBCF'];

  let cells = '';
  let dayCounter = 1;
  for (let week = 0; week < 6; week += 1) {
    cells += '<tr>';
    for (let weekday = 0; weekday < 7; weekday += 1) {
      if (week === 0 && weekday < firstDay) {
        cells += '<td class="empty"></td>';
      } else if (dayCounter > daysInMonth) {
        cells += '<td class="empty"></td>';
      } else {
        const dateString = getMonthDateString(year, month, dayCounter);
        const dayInfo = monthData[dateString];
        const minutes = dayInfo.totalMinutes;
        const label = minutes > 0 ? `${minutes}分` : '';
        const isToday = shouldHighlightToday && dateString === todayKey;
        const bg = minutes > 0 ? colorMap[(dayCounter - 1) % colorMap.length] : 'transparent';
        const todayBg = isToday ? '#1e293b' : bg;
        const textColor = isToday ? '#ffffff' : (minutes > 0 ? '#ffffff' : '#1e293b');
        cells += `
          <td class="day-cell${minutes > 0 ? ' filled' : ''}${isToday ? ' today' : ''}" style="background:${todayBg}; color:${textColor};${isToday ? ' box-shadow: inset 0 0 0 3px #0f172a, inset 0 0 0 1px rgba(255,255,255,0.2);' : ''}">
            <div class="day-number">${dayCounter}</div>
            <div class="day-details">${label}</div>
          </td>`;
        dayCounter += 1;
      }
    }
    cells += '</tr>';
    if (dayCounter > daysInMonth) break;
  }

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>${monthTitle} カレンダー</title>
  <style>
    body {
      margin: 0;
      font-family: 'Segoe UI', Arial, sans-serif;
      background: #f4f7fb;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 20px;
    }
    .calendar {
      width: 100%;
      max-width: 900px;
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.12);
      padding: 30px;
    }
    h1 {
      margin: 0 0 20px;
      text-align: center;
      color: #333;
    }
    .grid {
      width: 100%;
      border-collapse: collapse;
    }
    .grid th,
    .grid td {
      border: 1px solid #e0e7ff;
      width: 14.285%;
      height: 120px;
      vertical-align: top;
      padding: 10px;
    }
    .grid th {
      background: #eef2ff;
      color: #334155;
      font-weight: 700;
    }
    .day-cell {
      background: #ffffff;
      color: #1e293b;
      transition: transform 0.18s ease, box-shadow 0.18s ease;
      border-radius: 10px;
    }
    .day-cell.filled {
      color: #ffffff;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14);
    }
    .day-cell:hover {
      transform: translateY(-3px);
      box-shadow: 0 12px 24px rgba(15,23,42,0.16);
    }
    .day-cell.today {
      font-weight: 800;
      transform: scale(1.02);
      box-shadow: inset 0 0 0 3px #0f172a, inset 0 0 0 1px rgba(255,255,255,0.2);
    }
    .day-number {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .day-details {
      font-size: 14px;
      white-space: pre-wrap;
      line-height: 1.4;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      margin-top: 20px;
      gap: 12px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #f8fafc;
      padding: 10px 14px;
      border-radius: 999px;
      font-size: 14px;
      color: #334155;
    }
    .legend-color {
      width: 14px;
      height: 14px;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <div class="calendar">
    <h1>${monthTitle} 活動カレンダー</h1>
    <table class="grid">
      <thead>
        <tr>${labels.map(label => `<th>${label}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${cells}
      </tbody>
    </table>
    <div class="legend">
      <div class="legend-item"><span class="legend-color" style="background:#FF6384"></span> アクティブ日</div>
      <div class="legend-item"><span class="legend-color" style="background:#eef2ff"></span> 無活動日</div>
    </div>
  </div>
</body>
</html>`;

  return html;
}

function saveMonthlyCalendar(outputFile = null, target = null) {
  const filename = outputFile || path.join(__dirname, 'monthly_calendar.html');
  const html = generateMonthlyCalendar(target);
  fs.writeFileSync(filename, html);
  console.log(`🗓️ Calendar saved to: ${filename}`);
  return filename;
}

module.exports = {
  logActivity,
  getTodayActivities,
  generatePieChart,
  savePieChart,
  generateMonthlyCalendar,
  saveMonthlyCalendar,
  loadActivities,
  formatJST,
  getJSTDate,
  // sleep helpers
  loadSleepSessions,
  saveSleepSessions,
  startSleepSession,
  stopSleepSession,
  addPendingSleep,
  markPendingSleepPhoneUsed,
  clearPendingSleep,
  exportSleepSessions,
  importSleepSessions,
  getWeeklySleepTotals
};
