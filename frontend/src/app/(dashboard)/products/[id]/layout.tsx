export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function DynamicProductLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
