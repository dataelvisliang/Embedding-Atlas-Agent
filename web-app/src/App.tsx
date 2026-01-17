import { useState, useEffect } from 'react';
import { coordinator, wasmConnector } from '@uwdata/mosaic-core';
import { EmbeddingAtlas } from 'embedding-atlas/react';
import { MessageCircle, X, Send } from 'lucide-react';
import './App.css';

// Initialize coordinator globally
const c = coordinator();

function App() {
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant', content: string }[]>([
    { role: 'assistant', content: 'Hello! Ask me anything about the TripAdvisor reviews.' }
  ]);
  const [input, setInput] = useState('');
  const [dataLoaded, setDataLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPoints, setSelectedPoints] = useState<any[]>([]);

  useEffect(() => {
    async function init() {
      try {
        console.log("Initializing Mosaic Coordinator...");
        // Initialize DuckDB connection asynchronously
        const connector = await wasmConnector();
        c.databaseConnector(connector);

        // Use BASE_URL to correctly locate data on GitHub Pages (subdirectory) or Dev (root)
        // import.meta.env.BASE_URL is set in vite.config.ts
        const baseUrl = import.meta.env.BASE_URL.endsWith('/')
          ? import.meta.env.BASE_URL
          : import.meta.env.BASE_URL + '/';

        const dataUrl = new URL(`${baseUrl}atlas/data/dataset.parquet`, window.location.origin).href;

        console.log("Loading parquet data from:", dataUrl);
        await c.exec(`
          CREATE OR REPLACE TABLE reviews AS
          SELECT * FROM read_parquet('${dataUrl}')
        `);

        console.log("Parquet loaded successfully.");
        setDataLoaded(true);
      } catch (e: any) {
        console.error("Initialization failed:", e);
        setError(e.message || String(e));
      }
    }
    init();
  }, []);

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages(prev => [...prev, { role: 'user', content: input }]);

    // Logic for "Context-Aware" Chat
    const contextInfo = selectedPoints.length > 0
      ? `(Context: ${selectedPoints.length} reviews selected)`
      : "(Context: All reviews)";

    setTimeout(() => {
      setMessages(prev => [...prev, { role: 'assistant', content: `I received: "${input}". ${contextInfo}. Backend integration coming next!` }]);
    }, 1000);
    setInput('');
  };

  return (
    <div className="app-container">
      <div className="atlas-container">
        {error ? (
          <div className="loading-screen" style={{ color: '#ef4444' }}>
            <p>Error loading Atlas:</p>
            <pre>{error}</pre>
          </div>
        ) : dataLoaded ? (
          <EmbeddingAtlas
            coordinator={c}
            data={{
              table: "reviews",
              id: "__row_index__",
              text: "description",
              projection: { x: "projection_x", y: "projection_y" },
              neighbors: "neighbors"
            }}
            embeddingViewConfig={{
              pointSize: 3,
            }}
            initialState={{ version: "0.0.0", timestamp: Date.now() }}
            // @ts-ignore
            onSelection={(selection) => {
              // This is the bridge Phase 1!
              // 'selection' is an array of data points
              console.log("Selection updated:", selection?.length);
              setSelectedPoints(selection || []);
              if (selection && selection.length > 0 && !isChatOpen) {
                // Auto-open chat if useful? Maybe just show a badge.
              }
            }}
          />
        ) : (
          <div className="loading-screen">
            <div className="spinner"></div>
            <p>Initializing Native Atlas...</p>
          </div>
        )}
      </div>

      <div className={`chat-widget ${isChatOpen ? 'open' : ''}`}>
        {!isChatOpen && (
          <button className="chat-fab" onClick={() => setIsChatOpen(true)}>
            <MessageCircle size={24} />
            <span>Ask AI</span>
            {selectedPoints.length > 0 && (
              <span className="selection-badge">{selectedPoints.length}</span>
            )}
          </button>
        )}

        {isChatOpen && (
          <div className="chat-window">
            <div className="chat-header">
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <h3>Review Assistant</h3>
                {selectedPoints.length > 0 && (
                  <span style={{ fontSize: '10px', color: '#60a5fa', fontWeight: 'normal' }}>
                    Focusing on {selectedPoints.length} selected items
                  </span>
                )}
              </div>
              <button onClick={() => setIsChatOpen(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="chat-messages">
              {messages.map((msg, i) => (
                <div key={i} className={`message ${msg.role}`}>
                  {msg.content}
                </div>
              ))}
            </div>
            <div className="chat-input-area">
              <input
                type="text"
                placeholder="Ask about sentiments, topics..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              />
              <button onClick={handleSend}>
                <Send size={18} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
