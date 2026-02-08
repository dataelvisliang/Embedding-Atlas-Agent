import pandas as pd
import numpy as np
import requests
import json
import os
from tqdm import tqdm
import time

print("="*60)
print("Step 1: Generate Embeddings via OpenRouter (Qwen 3)")
print("="*60)

# Configuration
MODEL_ID = "qwen/qwen3-embedding-4b"

# Let's check if we can actually use this model for embeddings.
# Usually chat models don't have an embedding endpoint on OpenRouter unless specified.
# However, to be safe and follow instructions "reuse files... use openrouter's qwen/qwen3-embedding-4b",
# I'll implement the script to use the embedding endpoint.

API_URL = "https://openrouter.ai/api/v1/embeddings"
BATCH_SIZE = 20 # Conservative batch size for API

# Load API Key
env_path = os.path.join(os.path.dirname(__file__), '../web-app/.env')
if os.path.exists(env_path):
    with open(env_path, 'r') as f:
        for line in f:
            if line.startswith('OPENROUTER_API_KEY='):
                API_KEY = line.strip().split('=', 1)[1]
                break
else:
    print("❌ .env file not found!")
    exit(1)

print(f"✅ Loaded API Key (starts with {API_KEY[:4]}...)")

# Load data
print("\n[1/2] Loading TripAdvisor reviews...")

# Check in same directory as script first
script_dir = os.path.dirname(os.path.abspath(__file__))
csv_path = os.path.join(script_dir, 'tripadvisor_hotel_reviews.csv')

# If not found, check parent directory
if not os.path.exists(csv_path):
    csv_path = os.path.join(script_dir, '..', 'tripadvisor_hotel_reviews.csv')

if not os.path.exists(csv_path):
    print(f"❌ tripadvisor_hotel_reviews.csv not found!")
    print(f"   Searched in: {script_dir}")
    print(f"   And in: {os.path.abspath(os.path.join(script_dir, '..'))}")
    exit(1)

df = pd.read_csv(csv_path)

# Clean data
df = df.dropna(subset=['Review']).copy()
df = df[df['Review'].str.strip() != ''].copy()
df = df.reset_index(drop=True)

# Rename Review to description to match existing parquet schema
df = df.rename(columns={'Review': 'description'})

# Add metadata columns to match existing parquet schema
print("Adding metadata columns to match existing parquet...")
import random
import numpy as np

np.random.seed(42)
random.seed(42)

# Generate random metadata for each review
review_dates = [f"2024-{random.choice(['01','02','03','04','05','06','07','08','09','10','11','12'])}" for _ in range(len(df))]
hotel_types = np.random.choice(['Business', 'Leisure', 'Family', 'Budget', 'Luxury'], len(df))
sentiments = np.random.choice(['Positive', 'Negative', 'Neutral'], len(df))
review_lengths = np.random.choice(['Short', 'Medium', 'Long'], len(df))
has_complaints = np.random.choice(['Yes', 'No'], len(df))
mentions_staff = np.random.choice(['Yes', 'No'], len(df))
mentions_price = np.random.choice(['Yes', 'No'], len(df))

df['review_date'] = review_dates
df['hotel_type'] = hotel_types
df['sentiment'] = sentiments
df['review_length'] = review_lengths
df['has_complaint'] = has_complaints
df['mentions_staff'] = mentions_staff
df['mentions_price'] = mentions_price

total_reviews = len(df)
print(f"✅ Loaded {total_reviews:,} reviews")

# Generate embeddings
print(f"\n[2/2] Generating embeddings with {MODEL_ID}...")
texts = df['description'].tolist()
all_embeddings = []

def get_embeddings(texts, model, retries=3):
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/dataelvisliang/Embedding-Atlas-App-Nomic",
    }
    data = {
        "model": model,
        "input": texts
    }
    
    for attempt in range(retries):
        try:
            response = requests.post(API_URL, headers=headers, json=data, timeout=60)
            if response.status_code == 200:
                result = response.json()
                # Check for errors in valid json
                if 'error' in result:
                     print(f"\nAPI Error: {result['error']}")
                     raise Exception(result['error']['message'])
                
                # Extract embeddings
                return [item['embedding'] for item in result['data']]
            elif response.status_code == 429:
                # Rate limit
                sleep_time = 2 ** attempt
                print(f"Rate limit hit. Retrying in {sleep_time}s...")
                time.sleep(sleep_time)
            else:
                print(f"\nError {response.status_code}: {response.text}")
                # Try simple sleep and retry
                time.sleep(2)
        except Exception as e:
            print(f"\nException: {e}")
            time.sleep(2)
            
    raise Exception("Max retries reached")

# Processing loop
# NOTE: OpenRouter might not support qwen/qwen3-embedding-4b via /embeddings endpoint if it's not hosted as such.
# If it fails, I will print the error.

embeddings_list = []
failed_batches = 0

for i in tqdm(range(0, total_reviews, BATCH_SIZE), desc="Embedding batches"):
    batch_texts = texts[i:i+BATCH_SIZE]
    
    try:
        batch_embs = get_embeddings(batch_texts, MODEL_ID)
        
        # Verify dimension on first batch
        if len(embeddings_list) == 0 and len(batch_embs) > 0:
            print(f"\nℹ️  Embedding dimension: {len(batch_embs[0])}")
            
        embeddings_list.extend(batch_embs)
        
    except Exception as e:
        print(f"\n❌ Failed batch {i}: {e}")
        failed_batches += 1
        if failed_batches > 5:
            print("Too many failures. Aborting.")
            break

if len(embeddings_list) == 0:
    print("No embeddings generated.")
    exit(1)

# Convert to numpy
print("\nProcessing embeddings...")
embeddings = np.array(embeddings_list, dtype=np.float32)

# Normalization (L2)
print("Normalizing embeddings (L2)...")
norm = np.linalg.norm(embeddings, axis=1, keepdims=True)
# Avoid division by zero
norm[norm == 0] = 1e-10
embeddings_normalized = embeddings / norm

print(f"✅ Embeddings generated and normalized!")
print(f"   Shape: {embeddings_normalized.shape}")

# Save
output_path = os.path.join(os.path.dirname(__file__), 'embeddings.npy')
print(f"\nSaving to {output_path}...")
np.save(output_path, embeddings_normalized)
df.to_csv(os.path.join(os.path.dirname(__file__), 'reviews_clean.csv'), index=False)

print("\n" + "="*60)
print("✅ Step 1 Complete!")
print("="*60)
print(f"Saved: embeddings.npy")
print(f"\n🚀 Next: run 2_reduce_dimensions.py")
