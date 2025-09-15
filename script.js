let evtSource = null;
let speedChart = null;
let speedData = [];
let lastSmoothed = 0;

function fetchSongInfo() {
  const url = document.getElementById('youtubeLink').value.trim();
  if (!url) return alert("ইউটিউব লিংক দিন");

  fetch('/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  })
  .then(r => r.json())
  .then(data => {
    document.getElementById('thumbnail').src = data.thumbnail;
    document.getElementById('title').innerText = data.title;
    document.getElementById('duration').innerText = `সময়: ${data.duration} মিনিট`;
    document.getElementById('size').innerText = `আনুমানিক সাইজ: ${data.filesize} MB`;
    document.getElementById('songInfo').classList.remove('hidden');
    loadHistory();
    applyThemeFromThumbnail(data.thumbnail);
  })
  .catch(() => alert("তথ্য আনতে সমস্যা হয়েছে"));
}

function startDownload() {
  const url = document.getElementById('youtubeLink').value.trim();
  if (!url) return alert("ইউটিউব লিংক দিন");

  // reset UI
  document.getElementById('progressContainer').classList.remove('hidden');
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('progressText').innerText = '';
  document.getElementById('shareBtn').disabled = true;
  speedData = [];
  lastSmoothed = 0;
  initChart();

  // close any previous SSE
  if (evtSource) { evtSource.close(); }

  // SSE stream
  evtSource = new EventSource('/progress');
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    updateProgressUI(data);
    updateSpeedChart(data.speed);
    if (data.status === 'finished') {
      document.getElementById('progressText').innerText += "  ✅ ডাউনলোড সম্পন্ন!";
      document.getElementById('shareBtn').disabled = false;
      evtSource.close();
      loadHistory();
    }
  };

  // trigger download
  fetch('/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
}

function updateProgressUI(data) {
  const bar = document.getElementById('progressBar');
  const txt = document.getElementById('progressText');
  const total = data.total || 0;
  const downloaded = data.downloaded || 0;
  const speed = data.speed || 0;

  const percent = total > 0 ? Math.min(100, (downloaded / total) * 100) : 0;
  bar.style.width = percent + "%";

  const remaining = total > 0 ? Math.max(0, (total - downloaded)).toFixed(2) : '?';
  txt.innerText = `${downloaded.toFixed(2)} MB / ${total.toFixed(2)} MB — বাকি: ${remaining} MB — স্পিড: ${speed.toFixed(2)} MB/s`;
}

function initChart() {
  const ctx = document.getElementById('speedChart').getContext('2d');
  if (speedChart) { speedChart.destroy(); }
  speedChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'ডাউনলোড স্পিড (MB/s)',
        data: [],
        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        backgroundColor: 'rgba(40,167,69,0.15)',
        tension: 0.25,
        pointRadius: 0
      }]
    },
    options: {
      animation: false,
      responsive: true,
      scales: {
        x: { display: false },
        y: { beginAtZero: true, ticks: { stepSize: 0.5 } }
      },
      plugins: { legend: { display: false } }
    }
  });
}

function updateSpeedChart(rawSpeed) {
  // Exponential Moving Average for smoothing
  const alpha = 0.3; // smoothness
  const smoothed = lastSmoothed === 0 ? rawSpeed : (alpha * rawSpeed + (1 - alpha) * lastSmoothed);
  lastSmoothed = smoothed;

  speedData.push(smoothed);
  if (speedData.length > 60) speedData.shift(); // last 60 samples (~30s)

  const labels = speedData.map((_, i) => i.toString());
  speedChart.data.labels = labels;
  speedChart.data.datasets[0].data = speedData;
  speedChart.update();
}

function applyThemeFromThumbnail(src) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  img.onload = () => {
    const { r, g, b } = dominantColor(img);
    const accent = `rgb(${r}, ${g}, ${b})`;
    const bg = `linear-gradient(180deg, rgba(${r},${g},${b},0.10), #f7faf9)`;
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--bg', bg);
    // re-tint the chart if already made
    if (speedChart) {
      speedChart.data.datasets[0].borderColor = accent;
      speedChart.data.datasets[0].backgroundColor = `rgba(${r},${g},${b},0.15)`;
      speedChart.update();
    }
  };
}

function dominantColor(imageEl) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = canvas.width = 64;
  const h = canvas.height = 64;
  ctx.drawImage(imageEl, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  let r = 0, g = 0, b = 0, count = 0;
  // sample every 4th pixel for speed
  for (let i = 0; i < data.length; i += 16) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count++;
  }
  r = Math.round(r / count);
  g = Math.round(g / count);
  b = Math.round(b / count);
  // slight boost for vibrancy
  const boost = 1.05;
  return {
    r: Math.min(255, Math.round(r * boost)),
    g: Math.min(255, Math.round(g * boost)),
    b: Math.min(255, Math.round(b * boost))
  };
}

function previewSong() {
  const url = document.getElementById('youtubeLink').value.trim();
  if (!url) return alert("ইউটিউব লিংক দিন");
  fetch('/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  })
  .then(res => res.blob())
  .then(blob => {
    const audio = new Audio(URL.createObjectURL(blob));
    audio.play();
  });
}

function loadHistory() {
  fetch('/history')
    .then(r => r.json())
    .then(items => {
      const list = items.map(it => `<li>${it.title} — ${it.size}MB — ${it.date}</li>`).join('');
      document.getElementById('historyList').innerHTML = list || 'কোনো হিস্ট্রি নেই';
    });
}

// Simple share (works on Android Chrome via Web Share API if served over http/https)
function shareFile() {
  // এখানে সরাসরি ফাইল পাথ জানা নেই; ইউজার হিস্ট্রি থেকে বেছে নিতে পারে।
  if (!navigator.share) {
    alert('এই ডিভাইসে শেয়ার সাপোর্ট নেই।');
    return;
  }
  navigator.share({
    title: document.getElementById('title').innerText || 'Music',
    text: 'শুনে দেখো!',
    url: location.href
  });
}
