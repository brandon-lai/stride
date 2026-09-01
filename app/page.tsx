import Link from "next/link";

export default function Home() {
  return (
    <main style={{
      position: "fixed", inset: 0, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 18, padding: "6vmin", textAlign: "center",
    }}>
      <h1 style={{ fontSize: "9vmin", margin: 0, fontWeight: 800, lineHeight: 1 }}>Stride</h1>
      <p style={{ fontSize: "3vmin", color: "#9aa6bd", margin: 0, maxWidth: "28ch", lineHeight: 1.4 }}>
        An endless runner you play by actually running. Webcam only, nothing uploaded.
      </p>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", marginTop: "2vmin" }}>
        <Link href="/run/" style={{
          fontSize: "3vmin", fontWeight: 800, padding: "2vmin 5vmin", borderRadius: "1.4vmin",
          background: "#4dd2ff", color: "#06222b", textDecoration: "none",
        }}>Stand up and play</Link>
        <Link href="/play/" style={{
          fontSize: "3vmin", fontWeight: 700, padding: "2vmin 5vmin", borderRadius: "1.4vmin",
          background: "transparent", color: "#cbd6ea", textDecoration: "none", border: "2px solid #2b3c60",
        }}>Keyboard</Link>
      </div>
      <Link href="/debug/" style={{ fontSize: "2vmin", color: "#5d6a83", marginTop: "3vmin" }}>
        pose debug
      </Link>
    </main>
  );
}
