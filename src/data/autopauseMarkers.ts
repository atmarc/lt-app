import greekMarkers from "@/assets/data/autopause/greek.json";

const markersByCourse: Record<string, Record<string, number[]>> = {
  greek: greekMarkers as Record<string, number[]>,
};

export const getAutoPauseTimestamps = (
  course: string,
  lesson: number
): number[] => {
  return markersByCourse[course]?.[String(lesson + 1)] ?? [];
};
