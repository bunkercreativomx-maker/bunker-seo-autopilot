import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 text-center">
      <div className="text-6xl font-bold text-slate-300">404</div>
      <h1 className="mt-4 text-xl font-semibold text-slate-900">Page not found</h1>
      <p className="mt-2 text-sm text-slate-500">The page you&apos;re looking for doesn&apos;t exist or you don&apos;t have access to it.</p>
      <Link href="/dashboard" className="mt-6 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
        Go to Dashboard
      </Link>
    </div>
  );
}
