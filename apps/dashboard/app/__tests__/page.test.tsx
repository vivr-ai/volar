import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "../page";

describe("Home (placeholder page)", () => {
  it("renders the Volar placeholder heading", () => {
    render(<Home />);

    expect(
      screen.getByRole("heading", { name: "Volar" }),
    ).toBeInTheDocument();
  });
});
