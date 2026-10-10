import Link from "next/link";
import "./studio.css";

export default function StudioLayout({ children }) {
  return (
    <div className="studio">
      <header className="topbar">
        <Link href="/" className="brandmark">Carousel Studio</Link>
        <nav className="nav">
          <Link href="/">Dashboard</Link>
          <Link href="/queue">Review queue</Link>
        </nav>
      </header>
      {children}
    </div>
  );
}
