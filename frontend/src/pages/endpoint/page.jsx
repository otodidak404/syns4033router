import { useState, useEffect } from 'react';
import { getMachineId } from "@/shared/utils/machine";
import EndpointPageClient from "./EndpointPageClient";

export default function EndpointPage() {
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

  if (loading) {
    return <div className="text-text-muted text-sm py-12 text-center">Loading...</div>;
  }

  return <EndpointPageClient machineId={machineId} />;
}
