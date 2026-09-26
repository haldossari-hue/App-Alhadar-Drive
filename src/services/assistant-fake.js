/* نموذج محاكى للتطوير والاختبارات فقط (ASSISTANT_FAKE=1، ومعطّل في الإنتاج).
   يستخدم الأدوات الحقيقية عشان نختبر الواجهة والحلقة بدون تكلفة. */
export function fakeAssistantClient() {
  const create = async (p) => {
    const last = p.messages[p.messages.length - 1];
    if (typeof last.content === 'string') {
      const q = last.content;
      if (/شكو|بلاغ/.test(q)) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'آسفين على الإزعاج. وش صار بالضبط؟ واكتب اسمك وجوالك عشان نتواصل معك.' }] };
      if (/05\d{8}/.test(q)) {
        const phone = q.match(/05\d{8}/)[0];
        return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'f1', name: 'create_ticket', input: { category: 'complaint', subject: 'شكوى من عميل', details: q, order_code: '', contact_name: 'عميل', contact_phone: phone } }] };
      }
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'f2', name: 'get_service_info', input: {} }] };
    }
    const r = last.content.find((b) => b.type === 'tool_result');
    const data = JSON.parse(r.content);
    if (data.ticket_number) return { stop_reason: 'end_turn', content: [{ type: 'text', text: `تم رفع شكواك للإدارة برقم ${data.ticket_number}، وبيتواصلون معك قريب.` }] };
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: `رسوم التوصيل ${data.delivery_fee}.\nوالأحياء المشمولة:\n${data.districts.map((d) => '• ' + d).join('\n')}` }] };
  };
  return { messages: { create }, beta: { messages: { create } } };
}
