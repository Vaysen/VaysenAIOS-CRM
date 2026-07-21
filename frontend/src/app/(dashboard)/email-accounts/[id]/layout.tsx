export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function DynamicEmailAccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
