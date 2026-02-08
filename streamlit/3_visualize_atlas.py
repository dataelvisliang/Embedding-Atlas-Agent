# 3_visualize_atlas.py
import streamlit as st
import pandas as pd
import duckdb
from embedding_atlas.streamlit import embedding_atlas

st.set_page_config(layout="wide")

# Sidebar controls
with st.sidebar:
    st.title("🌍 Embedding Atlas")
    st.header("TripAdvisor Reviews")
    
    load_button = st.button("📂 Load Projected Data", type="primary")

# Initialize session state
if 'df_viz' not in st.session_state:
    st.session_state['df_viz'] = None

# Load processed data
if load_button:
    try:
        with st.spinner("Loading projected reviews..."):
            # Determine file path
            import os
            file_path = 'reviews_projected.parquet'
            
            # Check if file exists, if not look in data_pipeline
            if not os.path.exists(file_path):
                alt_path = os.path.join('..', 'data_pipeline', 'reviews_projected.parquet')
                if os.path.exists(alt_path):
                    file_path = alt_path
                else:
                    # Also try specific path if running from root without .. context
                    alt_path_2 = os.path.join('data_pipeline', 'reviews_projected.parquet')
                    if os.path.exists(alt_path_2):
                        file_path = alt_path_2

            # Load from Parquet to preserve data types
            df = pd.read_parquet(file_path)
            
            # Verify neighbors column is properly formatted
            sample = df['neighbors'].iloc[0]
            if isinstance(sample, dict):
                st.success("✅ Neighbors properly loaded as dict objects")
            else:
                st.warning(f"⚠️ Neighbors type: {type(sample)}")
            
            st.session_state['df_viz'] = df
            st.success(f"✅ Loaded {len(df):,} projected reviews from {file_path}")
            
    except FileNotFoundError:
        st.error("❌ reviews_projected.parquet not found!")
        st.info("Please run: python data_pipeline/2_reduce_dimensions.py")
        st.stop()
    except Exception as e:
        st.error(f"❌ Error loading data: {str(e)}")
        st.stop()

# Visualization
if st.session_state['df_viz'] is not None:
    df_viz = st.session_state['df_viz']
    
    st.header("🗺️ Interactive Review Atlas")
    st.info(f"Visualizing {len(df_viz):,} reviews")
    
    try:
        value = embedding_atlas(
            df_viz,
            text="description",
            x="projection_x",
            y="projection_y",
            neighbors="neighbors",
            show_table=False,
        )
        
        # Handle selection
        if value and "predicate" in value:
            predicate = value.get("predicate")
            
            if predicate is not None:
                st.subheader("📊 Selected Reviews")
                
                try:
                    selection = duckdb.query_df(
                        df_viz, "dataframe", 
                        "SELECT * FROM dataframe WHERE " + predicate
                    ).df()
                    
                    st.success(f"Selected {len(selection):,} reviews")
                    st.dataframe(selection[['description', 'Rating']])
                    
                    st.download_button(
                        label="📥 Download Selected Reviews",
                        data=selection.to_csv(index=False).encode('utf-8'),
                        file_name='selected_reviews.csv',
                        mime='text/csv'
                    )
                    
                except Exception as e:
                    st.error(f"Error querying selection: {str(e)}")
        
        # Download full data
        st.download_button(
            label="📥 Download All Projected Reviews (CSV)",
            data=df_viz.drop(columns=['neighbors']).to_csv(index=False).encode('utf-8'),
            file_name='reviews_projected_full.csv',
            mime='text/csv'
        )
        
    except Exception as e:
        st.error(f"❌ Error rendering Embedding Atlas: {str(e)}")
        st.exception(e)

else:
    st.info("👆 Click 'Load Projected Data' to visualize the reviews")

st.markdown("---")
st.markdown("Built with [Apple Embedding Atlas](https://apple.github.io/embedding-atlas/)")
