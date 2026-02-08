# 2_reduce_dimensions_with_metrics.py
import pandas as pd
import numpy as np
from umap import UMAP
from sklearn.neighbors import NearestNeighbors
from sklearn.manifold import trustworthiness
from sklearn.metrics import silhouette_score
from scipy.spatial.distance import pdist, squareform
from scipy.stats import spearmanr
from tqdm import tqdm
import gc
import os

print("="*60)
print("Step 2: Dimension Reduction with Quality Metrics")
print("="*60)

# Configuration
N_NEIGHBORS = 15
UMAP_N_EPOCHS = None
UMAP_MIN_DIST = 0.1

# Load embeddings
print("\n[1/6] Loading embeddings...")
file_path = 'embeddings.npy'
if not os.path.exists(file_path):
    if os.path.exists('data_pipeline/embeddings.npy'):
        file_path = 'data_pipeline/embeddings.npy'
    elif os.path.exists('../data_pipeline/embeddings.npy'):
        file_path = '../data_pipeline/embeddings.npy'
        
if not os.path.exists(file_path):
    print("❌ embeddings.npy not found!")
    print("Please run 1_generate_embeddings.py first")
    exit(1)

embeddings = np.load(file_path)
print(f"✅ Loaded embeddings: {embeddings.shape}")

# Load data
# Load data
print("\n[2/6] Loading review data...")
# Check in same directory as script first
script_dir = os.path.dirname(os.path.abspath(__file__))
csv_path = os.path.join(script_dir, 'winemag_clean.csv')

if not os.path.exists(csv_path):
    # Fallback to current dir
    if os.path.exists('winemag_clean.csv'):
        csv_path = 'winemag_clean.csv'

if not os.path.exists(csv_path):
    print(f"❌ winemag_clean.csv not found!")
    print(f"   Searched in: {script_dir}")
    print("   Please run 1_generate_embeddings.py first")
    exit(1)

df = pd.read_csv(csv_path)
print(f"✅ Loaded data: {len(df)} rows")

# Verify dimensions match
min_len = min(len(embeddings), len(df))
if len(embeddings) != len(df):
    print(f"⚠️ Trimming to {min_len:,} rows to align embeddings and data")
    embeddings = embeddings[:min_len]
    df = df.iloc[:min_len].copy().reset_index(drop=True)

total_reviews = len(df)
print(f"\nProcessing {total_reviews:,} reviews")

# Ensure unique ID column exists
if 'id' not in df.columns and '_id' not in df.columns:
    print("🔧 Adding 'id' column (stringified index) for Atlas compatibility")
    df['id'] = df.index.astype(str)
elif '_id' in df.columns and 'id' not in df.columns:
    df = df.rename(columns={'_id': 'id'})

df['id'] = df['id'].astype(str)
print(f"✅ ID column type: {df['id'].dtype} (first: '{df['id'].iloc[0]}')")

# UMAP Reduction
print("\n[3/6] Running UMAP reduction...")
print(f"Configuration:")
print(f"  - Components: 2")
print(f"  - Neighbors: {N_NEIGHBORS}")
print(f"  - Min distance: {UMAP_MIN_DIST}")
print(f"  - Metric: cosine")
print(f"  - CPU cores: {os.cpu_count()}")

umap_reducer = UMAP(
    n_components=2,
    n_neighbors=N_NEIGHBORS,
    min_dist=UMAP_MIN_DIST,
    metric='cosine',
    random_state=42,
    n_epochs=UMAP_N_EPOCHS,
    verbose=True,
    n_jobs=-1,
    low_memory=False
)

projections = umap_reducer.fit_transform(embeddings)

df['projection_x'] = projections[:, 0]
df['projection_y'] = projections[:, 1]

print(f"\n✅ UMAP complete!")
print(f"   X range: [{projections[:, 0].min():.4f}, {projections[:, 0].max():.4f}]")
print(f"   Y range: [{projections[:, 1].min():.4f}, {projections[:, 1].max():.4f}]")

# Calculate neighbors
print("\n[4/6] Computing neighbor graphs...")

knn = NearestNeighbors(
    n_neighbors=N_NEIGHBORS, 
    metric='cosine',
    algorithm='auto',
    n_jobs=-1
)

print("Fitting KNN model...")
knn.fit(embeddings)

print("Finding neighbors...")
distances, indices = knn.kneighbors(embeddings)

# Validate self-inclusion
print("🔍 Validating neighbor self-inclusion...")
assert indices[0][0] == 0, f"Self not at index 0 for row 0 (got {indices[0][0]})"
assert np.isclose(distances[0][0], 0.0, atol=1e-6), f"Self distance not ~0 (got {distances[0][0]})"
print("✅ Self-inclusion confirmed")

# Format neighbors
print("Formatting neighbors...")
neighbors_list = []
for i in tqdm(range(len(indices)), desc="Building neighbor list"):
    neighbor_dict = {
        "ids": indices[i].tolist(),
        "distances": distances[i].tolist()
    }
    neighbors_list.append(neighbor_dict)

df['neighbors'] = neighbors_list
print("✅ Neighbors computed!")

# ============================================================
# QUALITY METRICS
# ============================================================
print("\n[5/6] Computing Quality Metrics...")
print("="*60)

# For efficiency, use subset for some metrics if dataset is large
sample_size = min(5000, len(embeddings))
if len(embeddings) > sample_size:
    print(f"Using {sample_size:,} samples for expensive metrics...")
    sample_idx = np.random.choice(len(embeddings), sample_size, replace=False)
    sample_embeddings = embeddings[sample_idx]
    sample_projections = projections[sample_idx]
else:
    sample_embeddings = embeddings
    sample_projections = projections

# 1. Trustworthiness
print("\n1️⃣ Trustworthiness (are nearby points in 2D also close in high-D?)")
print("   Range: [0, 1], Higher is better (>0.9 is excellent)")
trust = trustworthiness(sample_embeddings, sample_projections, n_neighbors=N_NEIGHBORS)
print(f"   Score: {trust:.4f}")

# 2. Continuity (inverse of trustworthiness)
print("\n2️⃣ Continuity (are nearby points in high-D also close in 2D?)")
print("   Range: [0, 1], Higher is better (>0.9 is excellent)")
# Continuity = trustworthiness with swapped arguments
continuity = trustworthiness(sample_projections, sample_embeddings, n_neighbors=N_NEIGHBORS)
print(f"   Score: {continuity:.4f}")

# 3. Neighborhood Overlap
print("\n3️⃣ Neighborhood Overlap (k-NN preservation)")
print("   Range: [0, 1], Higher is better (>0.7 is good)")

# Get k-NN in high-D space
knn_high = NearestNeighbors(n_neighbors=N_NEIGHBORS, metric='cosine')
knn_high.fit(sample_embeddings)
neighbors_high = knn_high.kneighbors(sample_embeddings, return_distance=False)

# Get k-NN in low-D space
knn_low = NearestNeighbors(n_neighbors=N_NEIGHBORS, metric='euclidean')
knn_low.fit(sample_projections)
neighbors_low = knn_low.kneighbors(sample_projections, return_distance=False)

# Calculate overlap
overlaps = []
for i in range(len(neighbors_high)):
    set_high = set(neighbors_high[i])
    set_low = set(neighbors_low[i])
    overlap = len(set_high.intersection(set_low)) / N_NEIGHBORS
    overlaps.append(overlap)

neighborhood_overlap = np.mean(overlaps)
print(f"   Score: {neighborhood_overlap:.4f}")

# 4. Shepard Diagram Correlation (distance preservation)
print("\n4️⃣ Shepard Diagram Correlation (distance preservation)")
print("   Range: [-1, 1], Higher is better (>0.6 is good)")

# Sample pairs for efficiency
n_pairs = min(10000, (sample_size * (sample_size - 1)) // 2)
sample_pairs = min(1000, n_pairs)

high_d_dists = pdist(sample_embeddings[:sample_pairs], metric='cosine')
low_d_dists = pdist(sample_projections[:sample_pairs], metric='euclidean')

shepard_corr, _ = spearmanr(high_d_dists, low_d_dists)
print(f"   Spearman correlation: {shepard_corr:.4f}")

# 5. Local/Global Structure Preservation
print("\n5️⃣ Structure Preservation")

# Local: mean distance to k nearest neighbors
mean_local_dist_high = np.mean([distances[i][:N_NEIGHBORS].mean() for i in range(min(1000, len(distances)))])
knn_proj = NearestNeighbors(n_neighbors=N_NEIGHBORS, metric='euclidean')
knn_proj.fit(projections)
dist_proj, _ = knn_proj.kneighbors(projections[:min(1000, len(projections))])
mean_local_dist_low = np.mean([dist_proj[i].mean() for i in range(len(dist_proj))])

print(f"   Mean local distance (high-D): {mean_local_dist_high:.4f}")
print(f"   Mean local distance (low-D):  {mean_local_dist_low:.4f}")

# 6. Silhouette Score (if labels exist)
target_col = None
if 'points' in df.columns:
    target_col = 'points'
elif 'Rating' in df.columns:
    target_col = 'Rating'

if target_col:
    print(f"\n6️⃣ Silhouette Score (cluster quality by {target_col})")
    print("   Range: [-1, 1], Higher is better (>0.5 is good)")
    
    sample_ratings = df[target_col].iloc[:sample_size].values
    if len(np.unique(sample_ratings)) > 1:
        silhouette = silhouette_score(sample_projections, sample_ratings, metric='euclidean')
        print(f"   Score: {silhouette:.4f}")
    else:
        print("   Skipped (only one rating class)")

# 7. Stress (normalized residual variance)
print("\n7️⃣ Kruskal Stress (normalized residual variance)")
print("   Range: [0, 1], Lower is better (<0.1 is good)")

# Normalize distances
high_d_dists_norm = high_d_dists / high_d_dists.max()
low_d_dists_norm = low_d_dists / low_d_dists.max()

stress = np.sqrt(np.sum((high_d_dists_norm - low_d_dists_norm)**2) / np.sum(high_d_dists_norm**2))
print(f"   Stress: {stress:.4f}")

# Summary
print("\n" + "="*60)
print("📊 QUALITY METRICS SUMMARY")
print("="*60)
print(f"✓ Trustworthiness:        {trust:.4f}  {'✅ Excellent' if trust > 0.9 else '⚠️ Good' if trust > 0.8 else '❌ Poor'}")
print(f"✓ Continuity:             {continuity:.4f}  {'✅ Excellent' if continuity > 0.9 else '⚠️ Good' if continuity > 0.8 else '❌ Poor'}")
print(f"✓ Neighborhood Overlap:   {neighborhood_overlap:.4f}  {'✅ Good' if neighborhood_overlap > 0.7 else '⚠️ Fair' if neighborhood_overlap > 0.5 else '❌ Poor'}")
print(f"✓ Shepard Correlation:    {shepard_corr:.4f}  {'✅ Good' if shepard_corr > 0.6 else '⚠️ Fair' if shepard_corr > 0.4 else '❌ Poor'}")
print(f"✓ Kruskal Stress:         {stress:.4f}  {'✅ Good' if stress < 0.1 else '⚠️ Fair' if stress < 0.2 else '❌ Poor'}")
print("="*60)

# Save metrics to file
metrics_dict = {
    'trustworthiness': trust,
    'continuity': continuity,
    'neighborhood_overlap': neighborhood_overlap,
    'shepard_correlation': shepard_corr,
    'kruskal_stress': stress,
    'n_neighbors': N_NEIGHBORS,
    'sample_size': sample_size,
    'total_size': len(embeddings)
}

output_metrics_path = os.path.join(script_dir, 'projection_quality_metrics.csv')
metrics_df = pd.DataFrame([metrics_dict])
metrics_df.to_csv(output_metrics_path, index=False)
print(f"\n✅ Metrics saved to: {output_metrics_path}")

# Save projection data
print("\n[6/6] Saving projected data...")

# Add __row_index__ for Mosaic compatibility
print("Adding __row_index__ column...")
df['__row_index__'] = np.arange(len(df), dtype=np.int32)

output_parquet_path = os.path.join(script_dir, 'winemag_projected.parquet')
df.to_parquet(output_parquet_path, index=False, engine='pyarrow')

file_size_mb = os.path.getsize(output_parquet_path) / (1024 * 1024)
print(f"✅ Saved: {output_parquet_path} ({file_size_mb:.2f} MB)")

print("\n" + "="*60)
print("✅ Step 2 Complete!")
print("="*60)
print(f"📊 Quality Metrics: projection_quality_metrics.csv")
print(f"📁 Projected Data: reviews_projected.parquet")
print(f"\n🚀 Next: streamlit run 3_visualize_atlas.py")

# Cleanup
del embeddings, projections, knn, indices, distances, neighbors_list
gc.collect()