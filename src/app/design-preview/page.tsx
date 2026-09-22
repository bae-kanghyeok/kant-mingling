import { notFound } from "next/navigation";
import DesignPreview from "@/components/design/DesignPreview";

export const metadata = {
  title: "디자인 미리보기 · KANT Mingling",
  robots: { index: false, follow: false },
};

export default function DesignPreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <DesignPreview />;
}
