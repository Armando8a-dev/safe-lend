import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { sepolia } from "wagmi/chains";

export const config = getDefaultConfig({
  appName: "SafeLend",
  projectId: "c3bfa789688ced3fd58a97d6a014f557",
  chains: [sepolia],
  ssr: true,
});
