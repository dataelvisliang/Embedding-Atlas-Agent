# regenerate_static_export.py
# Generates a new static HTML export of Embedding Atlas with the latest version
import pandas as pd
from embedding_atlas import Atlas
import os

# Load the data
current_dir = os.path.dirname(os.path.abspath(__file__))
file_path = os.path.join(current_dir, 'reviews_projected.parquet')
df = pd.read_parquet(file_path)

print(f"Loaded {len(df)} rows")
print(f"Columns: {df.columns.tolist()}")

# Create the Atlas
atlas = Atlas(
    df,
    text="description",
    x="projection_x",
    y="projection_y",
    neighbors="neighbors"
)

# Export to HTML
html_content = atlas.export_html()

# Write to the web-app public folder
output_dir = os.path.join(current_dir, '..', 'web-app', 'public', 'atlas')
os.makedirs(output_dir, exist_ok=True)

# The export_html() returns a full HTML document
# We need to save it properly
output_path = os.path.join(output_dir, 'index.html')

with open(output_path, 'w', encoding='utf-8') as f:
    f.write(html_content)

print(f"Static export saved to: {output_path}")
print("Done!")
