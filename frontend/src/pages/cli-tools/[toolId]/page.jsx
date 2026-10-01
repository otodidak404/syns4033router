import { useState, useEffect } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { getMachineId } from "@/shared/utils/machine";
import ToolDetailClient from "./ToolDetailClient";

export default function ToolDetailPage() {
  const { toolId } = useParams();
  const [machineId, setMachineId] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getMachineId()
      .then(id => {
        if (active) {
          setMachineId(id);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  if (!toolId || !CLI_TOOLS[toolId]) {
    return <Navigate to="/dashboard/cli-tools" replace />;
  }

  if (loading) {
    return <div className="text-text-muted text-sm py-12 text-center">Loading...</div>;
  }

  return <ToolDetailClient toolId={toolId} machineId={machineId} />;
}
