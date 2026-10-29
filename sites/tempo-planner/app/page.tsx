export default function Home() {
  return (
    <main className="tempo-app" aria-label="Tempo Planner">
      <iframe
        className="tempo-screen"
        src="/src/"
        title="Tempo Planner"
        allow="microphone"
      />
    </main>
  );
}
