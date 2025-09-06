export default function ChatMessage({ sender, text, ts }) {
  const isUser = sender === 'user';
  return (
    <div className={`row ${isUser ? 'me' : ''}`}>
      <div className="bubble">
        <div>{text}</div>
        <div className="time">{new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
    </div>
  );
}