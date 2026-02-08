# regenerate_static_export.py
# Copies the processed data to the web-app for deployment
import shutil
import os

# Paths
current_dir = os.path.dirname(os.path.abspath(__file__))
source_file = os.path.join(current_dir, 'winemag_projected.parquet')
target_dir = os.path.join(current_dir, '..', 'web-app', 'public', 'atlas', 'data')
target_file = os.path.join(target_dir, 'dataset.parquet')

# Ensure target directory exists
os.makedirs(target_dir, exist_ok=True)

# Copy file
print(f"Copying data from {source_file}...")
shutil.copy2(source_file, target_file)

print(f"Data copied to: {target_file}")
print("Ready for web app deployment!")
