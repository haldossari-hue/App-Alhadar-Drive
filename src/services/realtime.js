/* بث لحظي عبر Server-Sent Events. كل اتصال معروف دوره وهويته، والرسائل توجَّه بدقة */

export function createHub() {
  const clients = new Set();

  function add(reply, who) {
    const c = { reply, role: who.role, sub: who.sub };
    clients.add(c);
    const ping = setInterval(() => write(c, ': ping\n\n'), 25000);
    reply.raw.on('close', () => { clearInterval(ping); clients.delete(c); });
    return c;
  }
  function write(c, chunk) {
    try { c.reply.raw.write(chunk); } catch { clients.delete(c); }
  }
  function send(filter, event) {
    const chunk = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of clients) if (filter(c)) write(c, chunk);
  }

  return {
    add,
    size: () => clients.size,
    all: (ev) => send(() => true, ev),
    admins: (ev) => send((c) => c.role === 'admin', ev),
    drivers: (ev) => send((c) => c.role === 'driver', ev),
    driver: (id, ev) => send((c) => c.role === 'driver' && c.sub === id, ev),
    customer: (phone, ev) => send((c) => c.role === 'customer' && c.sub === phone, ev),
  };
}
