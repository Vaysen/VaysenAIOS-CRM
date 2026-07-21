export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function DynamicProductEditLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
