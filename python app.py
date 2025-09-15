# app.py
import os
import threading
import time
import uuid
from flask import Flask, render_template, request, jsonify, send_from_directory, abort
from yt_dlp import YoutubeDL

app = Flask(__name__, static_folder='static', template_folder='templates')
DOWNLOAD_DIR = os.path.join(os.getcwd(), 'downloads')
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

# Global dict to keep task progress
tasks = {}

# Helper: format seconds -> mm:ss
def fmt_duration(sec):
    try:
        sec = int(sec)
    except:
        return "00:00"
    m = sec // 60
    s = sec % 60
    return f"{m:02d}:{s:02d}"

# Get info (title, thumbnail, duration)
@app.route('/info', methods=['POST'])
def info():
    data = request.json or {}
    url = data.get('url')
    if not url:
        return jsonify({'ok': False, 'error': 'No url provided'}), 400
    ydl_opts = {'quiet': True, 'skip_download': True}
    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500

    title = info.get('title')
    thumbnail = info.get('thumbnail')
    duration = info.get('duration') or 0
    duration_str = fmt_duration(duration)

    # estimated size using chosen bitrate 64 kbps: size_bytes = sec * 64000 / 8
    bitrate_bps = 64_000
    est_bytes = int((duration * bitrate_bps) / 8)
    est_mb = round(est_bytes / (1024*1024), 2)

    return jsonify({
        'ok': True,
        'title': title,
        'thumbnail': thumbnail,
        'duration_seconds': duration,
        'duration': duration_str,
        'estimated_size_mb': est_mb
    })

# Background download function
def download_task(task_id, url):
    out_path = os.path.join(DOWNLOAD_DIR, f"{task_id}.mp3")
    tasks[task_id]['status'] = 'starting'
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(DOWNLOAD_DIR, f'{task_id}.%(ext)s'),
        'quiet': True,
        'noplaylist': True,
        'progress_hooks': [],
        # postprocessor to convert to mp3 with ffmpeg, set sample rate and bitrate
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '64',  # will try 64 kbps
        }],
        # ensure ffmpeg gets args for sample rate and bitrate
        'postprocessor_args': ['-ar', '32000', '-b:a', '64k'],
    }

    # progress hook
    def hook(d):
        status = d.get('status')
        if status == 'downloading':
            downloaded_bytes = d.get('downloaded_bytes') or 0
            total_bytes = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
            speed = d.get('speed') or 0
            eta = d.get('eta') or None
            percent = d.get('downloaded_bytes') and total_bytes and round(downloaded_bytes*100/total_bytes,2) or None
            tasks[task_id].update({
                'status': 'downloading',
                'downloaded_bytes': downloaded_bytes,
                'total_bytes': total_bytes,
                'speed': speed,
                'eta': eta,
                'percent': percent
            })
        elif status == 'finished':
            tasks[task_id].update({
                'status': 'processing'
            })
        elif status == 'error':
            tasks[task_id].update({
                'status': 'error',
                'error': 'Download error'
            })

    ydl_opts['progress_hooks'].append(hook)

    try:
        with YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        # after conversion, find .mp3 file
        expected = os.path.join(DOWNLOAD_DIR, f"{task_id}.mp3")
        # sometimes yt-dlp writes with original extension then converts; ensure file exists
        if not os.path.exists(expected):
            # try to find any file starting with task_id.
            for f in os.listdir(DOWNLOAD_DIR):
                if f.startswith(task_id) and f.endswith('.mp3'):
                    expected = os.path.join(DOWNLOAD_DIR, f)
                    break

        if os.path.exists(expected):
            tasks[task_id].update({'status': 'finished', 'file': os.path.basename(expected)})
        else:
            tasks[task_id].update({'status': 'error', 'error': 'mp3 not found after processing'})

    except Exception as e:
        tasks[task_id].update({'status': 'error', 'error': str(e)})

# Start download endpoint
@app.route('/download', methods=['POST'])
def start_download():
    data = request.json or {}
    url = data.get('url')
    if not url:
        return jsonify({'ok': False, 'error': 'No url provided'}), 400
    task_id = str(uuid.uuid4().hex)[:12]
    tasks[task_id] = {
        'status': 'queued',
        'downloaded_bytes': 0,
        'total_bytes': 0,
        'speed': 0,
        'eta': None,
        'percent': 0,
        'file': None,
        'error': None
    }
    t = threading.Thread(target=download_task, args=(task_id, url), daemon=True)
    t.start()
    return jsonify({'ok': True, 'task_id': task_id})

# Status polling
@app.route('/status/<task_id>', methods=['GET'])
def status(task_id):
    info = tasks.get(task_id)
    if not info:
        return jsonify({'ok': False, 'error': 'invalid task id'}), 404
    # compute MB values
    downloaded_mb = round(info.get('downloaded_bytes', 0) / (1024*1024), 2)
    total_mb = round(info.get('total_bytes', 0) / (1024*1024), 2) if info.get('total_bytes') else None
    speed_kbps = round((info.get('speed') or 0)/1024, 2)  # KB/s
    return jsonify({
        'ok': True,
        'status': info.get('status'),
        'percent': info.get('percent'),
        'downloaded_mb': downloaded_mb,
        'total_mb': total_mb,
        'speed_kb_s': speed_kbps,
        'eta': info.get('eta'),
        'file': info.get('file'),
        'error': info.get('error')
    })

# Serve finished file
@app.route('/file/<task_id>', methods=['GET'])
def serve_file(task_id):
    info = tasks.get(task_id)
    if not info or info.get('status') != 'finished' or not info.get('file'):
        abort(404)
    return send_from_directory(DOWNLOAD_DIR, info['file'], as_attachment=True)

# index route
@app.route('/')
def index():
    return render_template('index.html')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
