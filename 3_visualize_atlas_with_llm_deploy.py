# 3_visualize_atlas.py
import streamlit as st
import pandas as pd
import duckdb
from embedding_atlas.streamlit import embedding_atlas
import requests
import json

st.set_page_config(layout="wide")

# OpenRouter API Configuration
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# Securely get API key from Streamlit secrets or environment
try:
    OPENROUTER_API_KEY = st.secrets["OPENROUTER_API_KEY"]
except (KeyError, FileNotFoundError):
    import os
    OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")

def chat_with_openrouter(messages, model="x-ai/grok-4.1-fast:free"):
    """Send chat request to OpenRouter API"""
    
    if not OPENROUTER_API_KEY:
        return "⚠️ OpenRouter API key not configured. Please add it to Streamlit secrets."
    
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8501",
        "X-Title": "TripAdvisor Review Atlas"
    }
    
    payload = {
        "model": model,
        "messages": messages
    }
    
    try:
        response = requests.post(OPENROUTER_API_URL, headers=headers, json=payload)
        response.raise_for_status()
        return response.json()['choices'][0]['message']['content']
    except Exception as e:
        return f"Error: {str(e)}"

# Initialize session state
if 'df_viz' not in st.session_state:
    st.session_state['df_viz'] = None
if 'selected_data' not in st.session_state:
    st.session_state['selected_data'] = None
if 'chat_history' not in st.session_state:
    st.session_state['chat_history'] = []
if 'last_predicate' not in st.session_state:
    st.session_state['last_predicate'] = None

# Sidebar controls
with st.sidebar:
    st.title("🌍 Embedding Atlas")
    st.header("TripAdvisor Reviews")
    
    st.markdown("---")
    st.subheader("🤖 Chat Settings")
    chat_model = st.selectbox(
        "Model",
        [
            "x-ai/grok-4.1-fast:free",
            "meta-llama/llama-3.2-3b-instruct:free",
            "openai/gpt-oss-20b:free",
            "deepseek/deepseek-chat-v3-0324:free"
        ],
        help="Select AI model for chat"
    )

# Fragment for chat interface - only this reruns on chat interactions
@st.fragment
def chat_interface(selection, chat_model):
    """Chat interface as a fragment - reruns independently"""
    st.markdown("### 💬 Chat with Selected Reviews")
    
    # Clear chat button
    if st.button("🗑️ Clear Chat History"):
        st.session_state['chat_history'] = []
        st.rerun(scope="fragment")
    
    # Display chat history
    chat_container = st.container(height=300)
    with chat_container:
        for msg in st.session_state['chat_history']:
            if msg['role'] == 'user':
                st.markdown(f"**You:** {msg['content']}")
            else:
                st.markdown(f"**AI:** {msg['content']}")
    
    # Chat form
    with st.form(key="chat_form", clear_on_submit=True):
        user_prompt = st.text_area(
            "Ask a question about the selected reviews:",
            placeholder="E.g., What are the common themes in these reviews?",
            height=100,
            key="chat_input_form"
        )
        
        submit_button = st.form_submit_button("🚀 Send", type="primary")
        
        if submit_button and user_prompt:
            with st.spinner("Thinking..."):
                # Prepare context from selected reviews
                reviews_text = "\n\n".join([
                    f"Review {i+1} (Rating: {row['Rating']}): {row['description']}"
                    for i, row in selection.head(20).iterrows()
                ])
                
                # Create system message with context
                system_msg = f"""You are an AI assistant analyzing TripAdvisor reviews. 

Here are the selected reviews to analyze:

{reviews_text}

Total reviews selected: {len(selection)}
Average rating: {selection['Rating'].mean():.2f}

Please answer the user's question based on these reviews."""
                
                # Build messages for API
                messages = [
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": user_prompt}
                ]
                
                # Get response
                response = chat_with_openrouter(messages, model=chat_model)
                
                # Update chat history
                st.session_state['chat_history'].append({
                    'role': 'user',
                    'content': user_prompt
                })
                st.session_state['chat_history'].append({
                    'role': 'assistant',
                    'content': response
                })
                
                st.rerun(scope="fragment")

# Auto-load data on startup
if st.session_state['df_viz'] is None:
    try:
        df = pd.read_parquet('reviews_projected.parquet')
        st.session_state['df_viz'] = df
        st.toast("Data loaded successfully!", icon="✅")
    except FileNotFoundError:
        st.toast("❌ reviews_projected.parquet not found!", icon="❌")
        st.error("❌ reviews_projected.parquet not found!")
        st.info("Please run: python 2_reduce_dimensions.py")
        st.stop()
    except Exception as e:
        st.toast(f"❌ Error loading data", icon="❌")
        st.error(f"❌ Error loading data: {str(e)}")
        st.stop()

# Visualization
if st.session_state['df_viz'] is not None:
    df_viz = st.session_state['df_viz']
    
    st.header("🗺️ Interactive Review Atlas")
    
    try:
        value = embedding_atlas(
            df_viz,
            text="description",
            x="projection_x",
            y="projection_y",
            neighbors="neighbors",
            show_table=False,
            show_charts=False
        )
        
        # Handle selection
        if value and "predicate" in value:
            predicate = value.get("predicate")
            
            # Only process if predicate changed (new selection)
            if predicate is not None and predicate != st.session_state['last_predicate']:
                try:
                    selection = duckdb.query_df(
                        df_viz, "dataframe", 
                        "SELECT * FROM dataframe WHERE " + predicate
                    ).df()
                    
                    # Store selection and predicate
                    st.session_state['selected_data'] = selection
                    st.session_state['last_predicate'] = predicate
                    # Clear chat history on new selection
                    st.session_state['chat_history'] = []
                    
                except Exception as e:
                    st.error(f"Error querying selection: {str(e)}")
            
            # Display selected data and chat interface
            if st.session_state['selected_data'] is not None:
                selection = st.session_state['selected_data']
                
                # Create two columns for display and chat
                col1, col2 = st.columns([1, 1])
                
                with col1:
                    st.markdown("### 📄 Selected Reviews")
                    st.dataframe(selection[['description', 'Rating']], height=400)
                    
                    st.download_button(
                        label="📥 Download Selected Reviews",
                        data=selection.to_csv(index=False).encode('utf-8'),
                        file_name='selected_reviews.csv',
                        mime='text/csv'
                    )
                
                with col2:
                    # Render chat interface as fragment
                    chat_interface(selection, chat_model)
        
    except Exception as e:
        st.error(f"❌ Error rendering Embedding Atlas: {str(e)}")
        st.exception(e)

else:
    st.info("⏳ Loading data...")

st.markdown("---")
st.markdown("Built with [Apple Embedding Atlas](https://apple.github.io/embedding-atlas/) | Powered by OpenRouter AI")
