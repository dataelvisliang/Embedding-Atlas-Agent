import { useState } from 'react';
import { MessageCircle, X, Send } from 'lucide-react';
import './App.css';

function App() {
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant', content: string }[]>([
    { role: 'assistant', content: 'Hello! Ask me anything about the TripAdvisor reviews.' }
  ]);
  const [input, setInput] = useState('');

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages(prev => [...prev, { role: 'user', content: input }]);
    // TODO: Connect to backend API
    setTimeout(() => {
      setMessages(prev => [...prev, { role: 'assistant', content: "I'm a demo bot. Backend integration coming soon!" }]);
    }, 1000);
    setInput('');
  };

  return (
    <div className="app-container">
      <iframe
        src="/atlas/index.html"
        className="atlas-iframe"
        title="Embedding Atlas"
      />

      <div className={`chat-widget ${isChatOpen ? 'open' : ''}`}>
        {!isChatOpen && (
          <button className="chat-fab" onClick={() => setIsChatOpen(true)}>
            <MessageCircle size={24} />
            <span>Ask AI</span>
          </button>
        )}

        {isChatOpen && (
          <div className="chat-window">
            <div className="chat-header">
              <h3>Review Assistant</h3>
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
