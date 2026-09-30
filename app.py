import os
import io
import json
import base64
import sqlite3
import numpy as np
import cv2
from PIL import Image
try:
    import onnxruntime as ort
except ImportError:
    ort = None

try:
    from facenet_pytorch import MTCNN
except ImportError:
    MTCNN = None

from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder='static', static_url_path='')
CORS(app)

# -------------------------------------------------------------
# Configuration & Paths
# -------------------------------------------------------------
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.abspath(os.path.join(CURRENT_DIR, '..'))
MODEL_PATH = os.path.join(CURRENT_DIR, 'w600k_r50.onnx') if os.path.exists(os.path.join(CURRENT_DIR, 'w600k_r50.onnx')) else os.path.join(BASE_DIR, 'models', 'w600k_r50.onnx')

# Check local directory first (for standalone deployment), then test_504_run, then parent directories
MERGE_DB_PATHS = [
    os.path.join(CURRENT_DIR, 'merge.db'),
    os.path.join(BASE_DIR, 'test_504_run', 'merge.db'),
    os.path.join(BASE_DIR, 'test_lead_verify', 'merge.db'),
    os.path.join(BASE_DIR, 'merge.db')
]
ALBUM_DB_PATHS = [
    os.path.join(CURRENT_DIR, 'album.db'),
    os.path.join(BASE_DIR, 'test_504_run', 'album.db'),
    os.path.join(BASE_DIR, 'test_lead_verify', 'album.db'),
    os.path.join(BASE_DIR, 'album.db')
]

THUMBNAIL_DIRS = [
    os.path.join(CURRENT_DIR, 'thumbs'),
    os.path.join(CURRENT_DIR, '.cache', 'thumbs')
]
for d in THUMBNAIL_DIRS:
    os.makedirs(d, exist_ok=True)

TAG_DESCRIPTIONS = {
    'BEST_IN_SCENE': 'Top-scoring frame for this person in multi-face shots (sharpest focus and best expression).',
    'HERO': 'Standout portrait with high aesthetic score (>= 0.85), sharp focus, and open eyes.',
    'CANDID': 'High quality natural keeper meeting focus and expression standards (score >= 0.50).',
    'BURST_DUPLICATE': 'Near-identical consecutive shot in a burst sequence (demoted to avoid duplicate picks).',
    'REJECT_BLUR': 'Soft or out of focus with focus score below minimum threshold (< 3.0).',
    'REJECT_BLINK': 'Subject caught blinking or with closed eyes (eye openness <= 0.35).',
    'UNCLASSIFIED': 'Standard photo without a specific culling tag.'
}

# Canonical ArcFace 112x112 5-point landmarks
DST_LANDMARKS = np.array([
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041]
], dtype=np.float32)

# -------------------------------------------------------------
# Global State & In-Memory Index
# -------------------------------------------------------------
r50_sess = None
mtcnn = None
clusters_data = []        # list of dicts: {id, imagePaths, faceScores, cullingTags, embedding}
cluster_embeddings = None # numpy array (N, 512) float32 L2 normalized
temp_id_to_path = {}      # dict: temp_id -> file path
active_merge_db = None
active_album_db = None

def init_models():
    global r50_sess, mtcnn
    if ort is None or MTCNN is None:
        print("Notice: onnxruntime or facenet_pytorch not installed in environment. Face scanner disabled, cluster culling & scoring verifier fully active.")
        return
    try:
        if os.path.exists(MODEL_PATH):
            print("Loading MTCNN Face Detector...")
            mtcnn = MTCNN(keep_all=True, min_face_size=24, thresholds=[0.6, 0.7, 0.7])
            print(f"Loading ONNX Model from {MODEL_PATH}...")
            sess_options = ort.SessionOptions()
            sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            r50_sess = ort.InferenceSession(MODEL_PATH, sess_options, providers=['CPUExecutionProvider'])
            print("Models loaded successfully.")
        else:
            print(f"Notice: Model not found at {MODEL_PATH}. Face scanner disabled, gallery and cluster culling fully active.")
    except Exception as e:
        print(f"Notice: Model loading skipped ({e}). Gallery and cluster culling fully active.")

def init_database():
    global clusters_data, cluster_embeddings, temp_id_to_path, active_merge_db, active_album_db
    
    # 1. Load Album DB (TempId -> Path)
    for p in ALBUM_DB_PATHS:
        if os.path.exists(p):
            active_album_db = p
            break
            
    if not active_album_db:
        print("WARNING: No album.db found!")
    else:
        print(f"Loading image paths from {active_album_db}...")
        conn = sqlite3.connect(active_album_db)
        c = conn.cursor()
        c.execute("SELECT TempId, Path FROM ImageData")
        for r in c.fetchall():
            if r[0] and r[1]:
                temp_id_to_path[str(r[0])] = str(r[1])
        conn.close()
        print(f"Loaded {len(temp_id_to_path)} image paths.")

    # 2. Load Merge DB (Clusters, Scores, Tags, Embeddings)
    for p in MERGE_DB_PATHS:
        if os.path.exists(p):
            active_merge_db = p
            break
            
    if not active_merge_db:
        print("WARNING: No merge.db found!")
        return

    print(f"Loading clusters from {active_merge_db}...")
    conn = sqlite3.connect(active_merge_db)
    c = conn.cursor()
    c.execute("PRAGMA table_info(clusters)")
    cols = [col[1] for col in c.fetchall()]
    has_tags = 'cullingTags' in cols
    if has_tags:
        c.execute("SELECT id, imagePaths, faceScores, cullingTags, embedding FROM clusters")
    else:
        c.execute("SELECT id, imagePaths, faceScores, embedding FROM clusters")
    rows = c.fetchall()
    conn.close()

    embeddings_list = []
    clusters_data = []

    for r in rows:
        cluster_id = r[0]
        try:
            image_paths = json.loads(r[1]) if r[1] else []
        except Exception:
            image_paths = []
            
        try:
            face_scores = json.loads(r[2]) if r[2] else []
        except Exception:
            face_scores = []
            
        if has_tags:
            try:
                culling_tags = json.loads(r[3]) if r[3] else []
            except Exception:
                culling_tags = []
            emb_blob = r[4]
        else:
            culling_tags = []
            emb_blob = r[3]

        if emb_blob and len(emb_blob) == 1024:
            emb_fp16 = np.frombuffer(emb_blob, dtype=np.float16).astype(np.float32)
            norm = np.linalg.norm(emb_fp16)
            if norm > 1e-6:
                emb_fp16 /= norm
            else:
                emb_fp16 = np.zeros(512, dtype=np.float32)
        else:
            emb_fp16 = np.zeros(512, dtype=np.float32)

        clusters_data.append({
            'id': cluster_id,
            'imagePaths': image_paths,
            'faceScores': face_scores,
            'cullingTags': culling_tags,
            'embedding': emb_fp16
        })
        embeddings_list.append(emb_fp16)

    if embeddings_list:
        cluster_embeddings = np.stack(embeddings_list, axis=0) # Shape: (N, 512)
    else:
        cluster_embeddings = np.empty((0, 512), dtype=np.float32)

    print(f"Loaded {len(clusters_data)} clusters from database.")

def align_face_chip(bgr_img, landmarks):
    src_pts = np.array(landmarks, dtype=np.float32)
    M, _ = cv2.estimateAffinePartial2D(src_pts, DST_LANDMARKS)
    if M is None:
        return None
    chip = cv2.warpAffine(bgr_img, M, (112, 112), borderValue=0)
    return chip

def extract_embedding_from_chip(chip_bgr):
    # Preprocess: (BGR - 127.5) / 128.0 -> shape (1, 3, 112, 112)
    blob = (chip_bgr.astype(np.float32) - 127.5) / 128.0
    blob = np.transpose(blob, (2, 0, 1))[np.newaxis, :, :, :]
    
    out = r50_sess.run(None, {'input.1': blob})[0][0]
    norm = np.linalg.norm(out)
    if norm > 1e-6:
        out /= norm
    return out

# -------------------------------------------------------------
# API Endpoints
# -------------------------------------------------------------

@app.route('/')
def serve_index():
    return send_from_directory('static', 'index.html')

@app.route('/api/stats', methods=['GET'])
def get_stats():
    has_tags = any(len(c.get('cullingTags', [])) > 0 for c in clusters_data)
    return jsonify({
        'total_clusters': len(clusters_data),
        'total_images': len(temp_id_to_path),
        'has_tags': has_tags,
        'active_merge_db': active_merge_db,
        'active_album_db': active_album_db
    })

@app.route('/api/reload', methods=['GET', 'POST'])
def reload_database():
    init_database()
    has_tags = any(len(c.get('cullingTags', [])) > 0 for c in clusters_data)
    return jsonify({
        'success': True,
        'message': f"Reloaded database successfully.",
        'active_merge_db': active_merge_db,
        'active_album_db': active_album_db,
        'total_clusters': len(clusters_data),
        'total_images': len(temp_id_to_path),
        'has_tags': has_tags
    })

@app.route('/api/clusters', methods=['GET'])
def get_clusters_list():
    summary = []
    for c in clusters_data:
        top_score = float(c['faceScores'][0]) if len(c['faceScores']) > 0 else 0.0
        first_img_id = c['imagePaths'][0] if len(c['imagePaths']) > 0 else None
        summary.append({
            'cluster_id': c['id'],
            'photo_count': len(c['imagePaths']),
            'top_score': round(top_score, 5),
            'first_image_id': first_img_id
        })
    # Sort by photo count descending
    summary.sort(key=lambda x: -x['photo_count'])
    return jsonify({'clusters': summary})

@app.route('/api/cluster/<int:cluster_id>', methods=['GET'])
def get_cluster_details(cluster_id):
    cluster = next((c for c in clusters_data if c['id'] == cluster_id), None)
    if not cluster:
        return jsonify({'error': 'Cluster not found'}), 404
        
    photos = build_sorted_photos_list(cluster)
    return jsonify({
        'cluster_id': cluster['id'],
        'total_photos': len(photos),
        'photos': photos
    })

def build_sorted_photos_list(cluster):
    image_paths = cluster['imagePaths']
    face_scores = cluster['faceScores']
    culling_tags = cluster['cullingTags']

    n = len(image_paths)
    items = []
    for i in range(n):
        temp_id = image_paths[i]
        score = float(face_scores[i]) if i < len(face_scores) else 0.0
        tag = culling_tags[i] if i < len(culling_tags) else "UNCLASSIFIED"
        full_path = temp_id_to_path.get(temp_id, "")
        filename = os.path.basename(full_path) if full_path else temp_id
        
        tag_desc = TAG_DESCRIPTIONS.get(tag, "Standard photo without specific tag.")
        items.append({
            'temp_id': temp_id,
            'full_path': full_path,
            'filename': filename,
            'score': round(score, 5),
            'culling_tag': tag,
            'tag_description': tag_desc,
            'image_url': f"/api/image/{temp_id}",
            'thumb_url': f"/api/image/{temp_id}?thumb=1"
        })

    # Ensure strictly sorted by score descending
    items.sort(key=lambda x: -x['score'])
    for idx, item in enumerate(items):
        item['rank'] = idx + 1

    return items

def find_thumbnail(temp_id):
    for d in THUMBNAIL_DIRS:
        for ext in ['.jpg', '.JPG', '.jpeg', '']:
            p = os.path.join(d, f"{temp_id}{ext}")
            if os.path.exists(p) and os.path.isfile(p):
                return p
    return None

@app.route('/api/image/<temp_id>', methods=['GET'])
def serve_image(temp_id):
    thumb_path = find_thumbnail(temp_id)
    is_thumb = request.args.get('thumb', '0') == '1'

    # If thumbnail requested and already cached
    if is_thumb and thumb_path:
        return send_file(thumb_path, mimetype='image/jpeg')

    full_path = temp_id_to_path.get(temp_id)
    if full_path and os.path.exists(full_path):
        if is_thumb:
            try:
                if thumb_path:
                    return send_file(thumb_path, mimetype='image/jpeg')
                target_dir = THUMBNAIL_DIRS[0]
                os.makedirs(target_dir, exist_ok=True)
                new_thumb = os.path.join(target_dir, f"{temp_id}.jpg")
                with Image.open(full_path) as im:
                    im.thumbnail((540, 540), Image.Resampling.LANCZOS)
                    im.convert('RGB').save(new_thumb, 'JPEG', quality=85)
                return send_file(new_thumb, mimetype='image/jpeg')
            except Exception:
                pass
        return send_file(full_path, mimetype='image/jpeg')

    # Fallback to cached thumbnail (vital for standalone cloud deployment where full RAW/JPG paths may not exist)
    if thumb_path:
        return send_file(thumb_path, mimetype='image/jpeg')

    alt_path = os.path.join(r"C:\Users\Atulya\Desktop\504", f"{temp_id}.JPG")
    if os.path.exists(alt_path):
        return send_file(alt_path, mimetype='image/jpeg')

    return "Image not found", 404

@app.route('/api/scan', methods=['POST'])
def scan_face():
    if mtcnn is None or r50_sess is None:
        return jsonify({
            'success': False,
            'error': 'Biometric face scanner model is not available in cloud container. Please use the Quick Cluster Browser to inspect all 593 person clusters and score rankings.'
        }), 200

    try:
        img_bgr = None
        
        # Check if file upload or base64 JSON
        if 'image_file' in request.files:
            file = request.files['image_file']
            file_bytes = np.frombuffer(file.read(), np.uint8)
            img_bgr = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)
        elif request.is_json:
            data = request.get_json()
            image_data = data.get('image', '')
            if ',' in image_data:
                image_data = image_data.split(',')[1]
            image_bytes = base64.b64decode(image_data)
            np_arr = np.frombuffer(image_bytes, np.uint8)
            img_bgr = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        if img_bgr is None:
            return jsonify({'success': False, 'error': 'Invalid image data received'}), 400

        # Convert to RGB PIL Image for MTCNN
        img_rgb = Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB))
        boxes, probs, landmarks = mtcnn.detect(img_rgb, landmarks=True)

        if boxes is None or len(boxes) == 0 or landmarks is None or len(landmarks) == 0:
            return jsonify({
                'success': False,
                'error': 'No face detected in the scan. Please center your face in good lighting and try again.'
            }), 200

        # Select largest face
        best_idx = 0
        max_area = 0
        for i, b in enumerate(boxes):
            area = (b[2] - b[0]) * (b[3] - b[1])
            if area > max_area:
                max_area = area
                best_idx = i

        chosen_landmarks = landmarks[best_idx]
        chosen_box = [float(x) for x in boxes[best_idx]]
        prob = float(probs[best_idx]) if probs is not None else 1.0

        # Canonical ArcFace alignment
        chip_bgr = align_face_chip(img_bgr, chosen_landmarks)
        if chip_bgr is None:
            return jsonify({'success': False, 'error': 'Could not align face landmarks.'}), 200

        # Create base64 thumbnail of the aligned chip for visual feedback
        _, chip_encoded = cv2.imencode('.jpg', chip_bgr)
        chip_b64 = "data:image/jpeg;base64," + base64.b64encode(chip_encoded).decode('utf-8')

        # Extract 512-D embedding
        query_emb = extract_embedding_from_chip(chip_bgr)

        # Match against clusters
        if cluster_embeddings is None or len(cluster_embeddings) == 0:
            return jsonify({'success': False, 'error': 'No cluster database available'}), 500

        similarities = np.dot(cluster_embeddings, query_emb)
        top_indices = np.argsort(-similarities)
        
        top_idx = top_indices[0]
        best_similarity = float(similarities[top_idx])
        matched_cluster = clusters_data[top_idx]

        # Top 5 candidates for UI diagnostics
        top_candidates = []
        for rank, idx in enumerate(top_indices[:5]):
            cand = clusters_data[idx]
            top_candidates.append({
                'rank': rank + 1,
                'cluster_id': cand['id'],
                'similarity': round(float(similarities[idx]), 4),
                'photo_count': len(cand['imagePaths'])
            })

        # Build sorted photo list for the matched cluster
        photos = build_sorted_photos_list(matched_cluster)

        # Match confidence assessment
        confidence_level = "High" if best_similarity >= 0.42 else ("Moderate" if best_similarity >= 0.33 else "Low")

        return jsonify({
            'success': True,
            'confidence_level': confidence_level,
            'similarity': round(best_similarity, 4),
            'similarity_pct': round(max(0.0, min(100.0, best_similarity * 100)), 1),
            'matched_cluster_id': matched_cluster['id'],
            'total_photos': len(photos),
            'top_score': photos[0]['score'] if photos else 0.0,
            'photos': photos,
            'chip_preview': chip_b64,
            'face_box': chosen_box,
            'top_candidates': top_candidates
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': f"Internal error during face scan: {str(e)}"}), 500

# -------------------------------------------------------------
# Main Runner & Initialization
# -------------------------------------------------------------
# Initialize data upon load so both gunicorn and python app.py have clusters & DB ready
init_database()
init_models()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"\n=======================================================")
    print(f"Celebrare Face Reco & Scoring Web App is ready!")
    print(f"Local URL: http://127.0.0.1:{port}")
    print(f"=======================================================\n")
    app.run(host='0.0.0.0', port=port, debug=False)
