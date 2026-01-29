import { useState, useEffect, useRef, useCallback } from 'react';
import { coordinator, wasmConnector, Coordinator } from '@uwdata/mosaic-core';
import { EmbeddingAtlas } from '@dataelvisliang/embedding-atlas/react';
import { MessageCircle, X, Send, Trash2, Database, Search, BarChart3 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgentChat } from './hooks/useAgentChat';
import './App.css';

// Initialize coordinator globally
const c = coordinator();


function App() {
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [input, setInput] = useState('');
  const [dataLoaded, setDataLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPoints, setSelectedPoints] = useState<any[]>([]);
  const [selectionPredicate, setSelectionPredicate] = useState<string | null>(null);
  const [coordinatorReady, setCoordinatorReady] = useState<Coordinator | null>(null);

  // Resizable chat window state
  const [chatSize, setChatSize] = useState({ width: 440, height: 600 });
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{ startX: number; startY: number; startWidth: number; startHeight: number } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Use the agent chat hook
  const {
    messages,
    isLoading,
    currentStep,
    toolsExecuted,
    highlightIds,
    sendMessage,
    clearChat,
    clearHighlight
  } = useAgentChat(coordinatorReady);

  // Fetch selected points when predicate changes
  useEffect(() => {
    async function fetchSelectedPoints() {
      if (!selectionPredicate || !coordinatorReady) {
        setSelectedPoints([]);
        return;
      }

      try {
        console.log("[Selection] Predicate changed:", selectionPredicate);

        // First get the total count of selected points
        const countQuery = `SELECT COUNT(*) as total FROM reviews WHERE ${selectionPredicate}`;
        const countResult = await coordinatorReady.query(countQuery);
        const totalCount = countResult.toArray()[0]?.total || 0;
        console.log("[Selection] Total selected:", totalCount);

        // Fetch more reviews - we'll truncate based on token limit in useAgentChat
        const query = `SELECT __row_index__ as identifier, Rating, description FROM reviews WHERE ${selectionPredicate} LIMIT 500`;
        console.log("[Selection] Querying sample:", query);

        const result = await coordinatorReady.query(query);
        const rows = result.toArray();
        console.log("[Selection] Got", rows.length, "sample points");

        // Transform to match expected format
        const points = rows.map((r: any) => ({
          identifier: r.identifier,
          text: r.description,
          fields: {
            Rating: r.Rating,
            description: r.description
          }
        }));

        // Attach totalCount as array property for access
        const pointsWithCount = Object.assign(points, { totalCount });
        setSelectedPoints(pointsWithCount);
      } catch (err) {
        console.error("[Selection] Failed to fetch selected points:", err);
        setSelectedPoints([]);
      }
    }

    fetchSelectedPoints();
  }, [selectionPredicate, coordinatorReady]);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  useEffect(() => {
    async function init() {
      try {
        console.log("Initializing Mosaic Coordinator...");
        const connector = await wasmConnector();
        c.databaseConnector(connector);

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
        setCoordinatorReady(c as unknown as Coordinator);
      } catch (e: any) {
        console.error("Initialization failed:", e);
        setError(e.message || String(e));
      }
    }
    init();
  }, []);

  // Resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: chatSize.width,
      startHeight: chatSize.height
    };
  }, [chatSize]);

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!isResizing || !resizeRef.current) return;

    // Since window is anchored at bottom-right, dragging left increases width
    const deltaX = resizeRef.current.startX - e.clientX;
    const deltaY = resizeRef.current.startY - e.clientY;

    const newWidth = Math.max(320, Math.min(800, resizeRef.current.startWidth + deltaX));
    const newHeight = Math.max(400, Math.min(window.innerHeight * 0.9, resizeRef.current.startHeight + deltaY));

    setChatSize({ width: newWidth, height: newHeight });
  }, [isResizing]);

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
    resizeRef.current = null;
  }, []);

  // Attach global mouse events for resize
  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleResizeMove);
      document.addEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';
    }
    return () => {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, handleResizeMove, handleResizeEnd]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    const userMessage = input.trim();
    setInput('');
    // Pass both selectedPoints and the predicate for tool queries
    await sendMessage(userMessage, selectedPoints, selectionPredicate);
  };

  // Tool icon mapping
  const getToolIcon = (toolName: string) => {
    switch (toolName) {
      case 'sql_query': return <Database size={12} />;
      case 'text_search': return <Search size={12} />;
      case 'get_stats': return <BarChart3 size={12} />;
      default: return <Database size={12} />;
    }
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
            highlight={highlightIds}
            initialState={{ version: "0.0.0", timestamp: Date.now() }}
            onStateChange={(state) => {
              // Only update if predicate actually changed to avoid re-render spam
              const newPredicate = state.predicate || null;
              setSelectionPredicate(prev => {
                if (prev !== newPredicate) {
                  console.log("[Atlas] Predicate changed:", newPredicate);
                  return newPredicate;
                }
                return prev;
              });
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
            <span>Atlas Agent</span>
            {selectedPoints.length > 0 && (
              <span className="selection-badge">{(selectedPoints as any).totalCount || selectedPoints.length}</span>
            )}
          </button>
        )}

        {isChatOpen && (
          <div
            className="chat-window"
            style={{
              width: `${chatSize.width}px`,
              height: `${chatSize.height}px`,
              maxHeight: '90vh'
            }}
          >
            {/* Resize handle */}
            <div
              className="resize-handle"
              onMouseDown={handleResizeStart}
              title="Drag to resize"
            />
            <div className="chat-header">
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <h3>
                  <Database size={16} style={{ marginRight: '6px', opacity: 0.7 }} />
                  Atlas Agent
                </h3>
                {selectedPoints.length > 0 && (
                  <span style={{ fontSize: '10px', color: '#60a5fa', fontWeight: 'normal' }}>
                    {(selectedPoints as any).totalCount || selectedPoints.length} items selected on map
                  </span>
                )}
                {highlightIds && highlightIds.length > 0 && (
                  <span
                    style={{
                      fontSize: '10px',
                      color: '#f97316',
                      fontWeight: 'normal',
                      cursor: 'pointer',
                      textDecoration: 'underline'
                    }}
                    onClick={clearHighlight}
                    title="Click to clear highlight"
                  >
                    {highlightIds.length} points highlighted (click to clear)
                  </span>
                )}
              </div>
              <div className="header-actions">
                <button onClick={clearChat} title="Clear chat">
                  <Trash2 size={16} />
                </button>
                <button onClick={() => setIsChatOpen(false)}>
                  <X size={20} />
                </button>
              </div>
            </div>

            <div className="chat-messages">
              {messages.map((msg, i) => (
                <div key={i} className={`message ${msg.role}`}>
                  <div className="message-content">
                    {msg.role === 'assistant' ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    ) : (
                      msg.content
                    )}
                  </div>
                  {msg.toolResults && msg.toolResults.length > 0 && (
                    <div className="tools-used">
                      {msg.toolResults.map((t, k) => (
                        <span key={k} className="tool-badge">
                          {getToolIcon(t.name)}
                          {t.name.replace('_', ' ')}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {/* Loading indicator with tool status */}
              {isLoading && (
                <div className="message assistant loading">
                  <div className="typing-indicator">
                    <span></span><span></span><span></span>
                  </div>
                  {currentStep && (
                    <div className="step-indicator">{currentStep}</div>
                  )}
                  {toolsExecuted.length > 0 && (
                    <div className="tools-executing">
                      {toolsExecuted.map((tool, i) => (
                        <span key={i} className="tool-badge executing">
                          {getToolIcon(tool)}
                          {tool.replace('_', ' ')}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            <div className="chat-input-area">
              <textarea
                placeholder={isLoading ? "Analyzing..." : "Ask about ratings, topics, trends... (Shift+Enter for new line)"}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  // Auto-resize textarea
                  e.target.style.height = 'auto';
                  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !isLoading) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                disabled={isLoading}
                rows={1}
              />
              <button onClick={handleSend} disabled={isLoading}>
                {isLoading ? (
                  <div className="spinner-small" />
                ) : (
                  <Send size={18} />
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
