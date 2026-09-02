import { proseCls } from "@/components/ui/styles";

/**
 * The navy band at the top of a console page (#1748). Every section is its own
 * route now, so every one of them needs the same title band, and thirteen copies
 * of it is how the widths in #1745 ended up disagreeing.
 */
export function AdminPageHeader({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl bg-pennie-navy px-7 py-6 dark:bg-surface">
      <p className="pn-eyebrow text-pennie-sky">Admin</p>
      <h1 className="pn-h3 mt-2 text-pennie-beige">{title}</h1>
      {children && (
        <div className={`mt-2 text-pennie-beige/75 ${proseCls}`}>{children}</div>
      )}
    </section>
  );
}

/**
 * What a person sees on a console route their role cannot open.
 *
 * The sidebar does not list an entry someone cannot use, so reaching one of these
 * means a typed address or an old link rather than a control that misled them.
 * It still says which level is needed, because "no" with no reason is a dead end.
 */
export function AdminDenied({ need }: { need: string }) {
  return (
    <p className="text-sm text-fg-muted">
      You need {need} account to open this page.
    </p>
  );
}
