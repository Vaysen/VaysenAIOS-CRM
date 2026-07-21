export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function DynamicImportLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
