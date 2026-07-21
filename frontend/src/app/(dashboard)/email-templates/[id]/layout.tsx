export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function DynamicEmailTemplateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
