export default function App() {
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        display: 'grid',
        placeItems: 'center',
        minHeight: '100vh',
        margin: 0,
        background: '#0b1020',
        color: '#e6e9f2',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ margin: '0 0 0.3em' }}>ThePlayPlus</h1>
        <p style={{ opacity: 0.7 }}>React + Vite 프런트엔드 배포 성공 🎉</p>
        <p style={{ opacity: 0.4, fontSize: '0.85rem' }}>
          served at /theplayplus/ · elda-ai.org
        </p>
      </div>
    </main>
  );
}
