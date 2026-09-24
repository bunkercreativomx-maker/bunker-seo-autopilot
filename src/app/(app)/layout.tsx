import { requireUser } from "@/lib/pocketbase/auth";
import { Sidebar } from "@/components/sidebar";
import { UserMenu } from "@/components/user-menu";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { pb, user } = await requireUser();

  // Resolve the organization name for the sidebar footer.
  let orgName = "My Organization";
  if (user.organization) {
    try {
      const org = await pb.collection("organizations").getOne(user.organization);
      orgName = (org as { name?: string }).name ?? orgName;
    } catch {
      // fall back to default
    }
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar orgName={orgName} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="hidden text-sm font-medium text-slate-500 sm:inline">{orgName}</span>
          </div>
          <div className="flex items-center gap-3">
            {/* Search placeholder */}
            <div className="hidden items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-400 lg:flex">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              <span>Search…</span>
            </div>
            {/* Notifications placeholder */}
            <button className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Notifications">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
              </svg>
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-sky-500" />
            </button>
            <UserMenu name={user.name ?? ""} email={user.email} role={user.role} />
          </div>
        </header>
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
