import { render, getMockContextProps } from "@stripe/ui-extension-sdk/testing";
import { ContextView } from "@stripe/ui-extension-sdk/ui";

import Home from "./Home";

describe("DashboardHomepageView", () => {
  it("renders ContextView with correct title", () => {
    const { wrapper } = render(<Home {...getMockContextProps()} />);
    const contextView = wrapper.find(ContextView);

    expect(contextView).not.toBeNull();
    expect(contextView?.prop("title")).toBe("Stripe Data Sync");
  });
});
