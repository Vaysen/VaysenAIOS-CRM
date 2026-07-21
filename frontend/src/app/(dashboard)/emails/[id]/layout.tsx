export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function DynamicEmailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
