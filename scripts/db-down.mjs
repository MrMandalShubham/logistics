import { execSync } from "node:child_process";
const NAME = process.env.PG_CONTAINER ?? "logistics-pg";
try {
  execSync(`docker rm -f ${NAME}`, { encoding: "utf8" });
  console.log(`removed ${NAME}`);
} catch {
  console.log(`${NAME} was not running`);
}
