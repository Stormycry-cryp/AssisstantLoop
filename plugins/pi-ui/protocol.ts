const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export function sessionOf(thread: string, url: string) {
  if (!UUID.test(thread)) throw new Error("Pi 线程编号不正确");
  const link = new URL(url);
  if (
    link.origin !== "http://127.0.0.1:3774" ||
    link.username ||
    link.password ||
    !link.pathname.endsWith(`/${thread}`)
  ) {
    throw new Error("Pi 会话链接不是本机线程链接");
  }
  return JSON.stringify({ thread, url });
}

export function parseSession(session: string) {
  const { thread, url } = JSON.parse(session);
  sessionOf(thread, url);
  return { thread: thread as string, url: url as string };
}

export function blocked(reason: string, about: string) {
  const receipt = {
    ask: [
      {
        title: "Pi 任务需要你处理",
        text: `Pi 没有交回已完成的结果：${reason.slice(0, 300)}。请先在 Opus Agent App 核实任务状态，保留已经完成的工作。`,
        options: ["已核实，继续剩余步骤", "结束这件事"],
        about: `${about}。先核实原线程中的输入是否仍在运行或已完成；不重做已完成的业务，不另开线程重复派活。`,
        key: "pi-ui-connection",
      },
    ],
  };
  return `待你处理：${reason.slice(0, 300)}\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\``;
}
