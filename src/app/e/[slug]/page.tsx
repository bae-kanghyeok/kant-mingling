import MingleApp from "@/components/MingleApp";

export default async function EventPage({ params }: PageProps<"/e/[slug]">) {
  const { slug } = await params;
  return <MingleApp slug={slug} />;
}
