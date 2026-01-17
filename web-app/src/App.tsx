import React, { useEffect, useState } from 'react';
import { coordinator, wasmConnector } from '@uwdata/mosaic-core';
import { EmbeddingAtlas } from 'embedding-atlas/react';
import { MessageCircle, X, Send } from 'lucide-react';
import './App.css';

// Initialize coordinator outside component to prevent recreation
const c = coordinator();
c.databaseConnector(wasmConnector({
  log: false, // Set to true for debugging
}));

function App() {
  const [loaded, setLoaded] = useState(false);
  const [selection, setSelection] = useState<any[]>([]);
  const [isChatOpen, setIsChatOpen] = useState(false);

  useEffect(() => {
    async function init() {
      try {
        // Load the parquet file
        // We use read_parquet with the absolute URL to ensure DuckDB treats it as a remote file
        const dataUrl = new URL('/data/dataset.parquet', window.location.href).href;
        await c.exec(`
          CREATE OR REPLACE TABLE reviews AS 
          SELECT * FROM read_parquet('${dataUrl}')
        `);
        setLoaded(true);
      } catch (err) {
        console.error("Failed to load data:", err);
      }
    }
    init();
  }, []);

  const handleSelection = (sel: any) => {
    // The selection prop can be complex. 
    // Usually EmbeddingAtlas manages its own selection via the coordinator,
    // but we can listen to it if we use the 'selection' state or listen to the table.
    // For now, let's just log it.
    console.log("Selection changed:", sel);

    // In a real implementation with Mosaic, we'd query the coordinator for selected rows
    // based on the predicate.
    // Ideally, we'd use a Mosaic 'Selection' object, but here we can just capture the output.
  };

  if (!loaded) {
    return (
      <div className="loading-screen">
        <div className="spinner"></div>
        <p>Loading Trip Advisor Atlas...</p>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div className="atlas-container">
        <EmbeddingAtlas
          coordinator={c}
          data={{
            table: "reviews",
            id: "_row_index", // Parquet export includes this
            text: "description",
            projection: { x: "projection_x", y: "projection_y" },
            neighbors: "neighbors"
          }}
          embeddingViewConfig={{
            pointSize: 3,
          }}
          // Basic props
          initialState={{ version: "0.0.0", timestamp: Date.now() }}
        />
      </div>

      {/* Floating Chat Button */}
      {!isChatOpen && (
        <button
          className="chat-fab"
          onClick={() => setIsChatOpen(true)}
        >
          <MessageCircle size={24} />
          <span>Ask AI</span>
        </button>
      )}

      {/* Chat Widget */}
      {isChatOpen && (
        <div className="chat-widget">
          <div className="chat-header">
            <h3>Atlas Assistant</h3>
            <button onClick={() => setIsChatOpen(false)}>
              <X size={20} />
            </button>
          </div>
          <div className="chat-body">
            <div className="chat-message bot">
              Hi! Select some points on the map and I can analyze them for you.
            </div>
            {/* Messages will go here */}
          </div>
          <div className="chat-input-area">
            <input type="text" placeholder="Ask about the selection..." />
            <button>
              <Send size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
