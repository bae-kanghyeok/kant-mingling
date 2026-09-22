import { notFound } from "next/navigation";
import RehearsalController from "@/components/rehearsal/RehearsalController";
import { assertRehearsalDeployment } from "@/server/rehearsal/guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "온라인 합성 리허설 · KANT Mingling",
  robots: { index: false, follow: false },
};

export default async function RehearsalPage({ params }: PageProps<"/rehearsal/[slug]">) {
  const { slug } = await params;
  try {
    assertRehearsalDeployment(slug);
  } catch {
    notFound();
  }
  return <RehearsalController slug={slug} />;
}
