export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function DynamicEmailTemplateEditLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
