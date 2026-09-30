# Celebrare AI — Face Recognition, Clustering & Photo Culling Verifier

An interactive, high-performance web dashboard and verification suite for AI-powered face recognition, face clustering, aesthetic quality scoring, and intelligent photo culling.

Built to visualize and verify the pipeline results across 504 high-resolution wedding & event images and 593 person clusters.

---

## 🌟 Key Features

- **Biometric Face Scanner & Matching**: Live webcam capture or photo upload, powered by ArcFace 512-D canonical landmark-aligned vector embeddings and cosine similarity search.
- **Strict Quality Scoring Hierarchy**: Photos within each person's cluster are ranked strictly in descending score order based on sharpness, facial frontality, eye openness, smile, and prominence.
- **Intelligent Photo Culling Classifications**:
  - 👑 **BEST_IN_SCENE**: Top-scoring frame for this individual across multi-subject shots.
  - ⭐ **HERO**: Standout portrait with high aesthetic score ($\ge 0.85$), tack-sharp focus, and open eyes.
  - 📸 **CANDID**: Natural keeper meeting quality and expression standards (score $\ge 0.50$).
  - 📑 **BURST_DUPLICATE**: Demoted consecutive shot in rapid burst sequences to eliminate duplicate deliveries.
  - 🌫️ **REJECT_BLUR**: Demoted out-of-focus or motion-blurred shot (focus score $< 3.0$).
  - 👁️ **REJECT_BLINK**: Demoted shot with closed eyes or mid-blink ($openness \le 0.35$).
- **Interactive Lightbox Modal**: Click any card to inspect full high-resolution previews, score progress bars, classification rationales, and exact file system paths.
- **Standalone Cloud-Ready Architecture**: Self-contained SQLite databases (`album.db`, `merge.db`) and pre-cached web-optimized JPEG thumbnails (`thumbs/`) ensure instant loading on any cloud platform.

---

## 🚀 Quick Deployment Guide

### Option 1: Deploy on Render (Recommended — 2 Minutes)
1. Go to [Render Dashboard](https://dashboard.render.com/) and click **New +** $\rightarrow$ **Web Service**.
2. Connect your GitHub repository: `https://github.com/Atulya-raj/culling-test-frontend`.
3. Configure settings:
   - **Environment**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app --bind 0.0.0.0:$PORT --workers 1 --threads 4 --timeout 120`
   - **Instance Type**: `Free`
4. Click **Create Web Service**. Once deployed, Render will provide a free live HTTPS URL (e.g., `https://culling-test-frontend.onrender.com`).

*(Or use Render Blueprints — the included `render.yaml` automatically configures this).*

---

### Option 2: Deploy on Railway
1. Go to [Railway.app](https://railway.app/) and click **New Project** $\rightarrow$ **Deploy from GitHub repo**.
2. Select `culling-test-frontend`.
3. Railway automatically detects the included `Dockerfile` and deploys it immediately.
4. Under **Settings** $\rightarrow$ **Networking**, click **Generate Domain** to get your public URL.

---

### Option 3: Run Locally (Windows / macOS / Linux)

```bash
# Clone the repository
git clone https://github.com/Atulya-raj/culling-test-frontend.git
cd culling-test-frontend

# Install dependencies
pip install -r requirements.txt

# Run application
python app.py
```
Open [http://localhost:5000](http://localhost:5000) in your browser. On Windows, you can also double-click `run.bat`.

---

## 📡 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Serves the main single-page application dashboard |
| `GET` | `/api/stats` | Returns total clusters, total dataset images, and active database status |
| `GET` | `/api/clusters` | Returns all 593 person clusters sorted by photo count |
| `GET` | `/api/cluster/<cluster_id>` | Returns all photos, face scores, and culling tags for a specific cluster |
| `GET` | `/api/image/<temp_id>` | Serves cached thumbnails or original images |
| `POST` | `/api/scan` | Accepts webcam capture or uploaded image and returns top-matched clusters |
| `POST` | `/api/reload` | Dynamically re-reads `merge.db` and `album.db` from disk without server restart |

---

## 📁 Repository Structure

```text
├── album.db          # SQLite database containing image metadata & face attributes
├── merge.db          # SQLite database containing clusters, embeddings, scores & tags
├── app.py            # Flask backend with API routing, caching, and serving logic
├── Procfile          # Production WSGI process definition for cloud hosts
├── requirements.txt  # Python package dependencies
├── render.yaml       # Render cloud deployment blueprint
├── Dockerfile        # Container image definition for Docker/Railway/Fly.io
├── run.bat           # 1-click Windows runner
├── static/
│   ├── index.html    # Modern UI layout with dual-panel scanner and gallery
│   ├── style.css     # Premium dark theme styling, glassmorphism, responsive grid
│   └── app.js        # Dynamic cluster browsing, filtering, and scanner logic
└── thumbs/           # Pre-cached optimized thumbnails for all 504 dataset images
```
