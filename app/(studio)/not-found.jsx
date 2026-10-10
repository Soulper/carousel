import Link from "next/link";
export default function NotFound() {
  return <div className="wrap"><h1>That page or story doesn't exist</h1><Link href="/">Back to the dashboard</Link></div>;
}
