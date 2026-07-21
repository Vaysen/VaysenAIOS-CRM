export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function DynamicEmailAccountEditLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
