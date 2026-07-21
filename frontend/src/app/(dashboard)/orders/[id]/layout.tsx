export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function DynamicOrderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
